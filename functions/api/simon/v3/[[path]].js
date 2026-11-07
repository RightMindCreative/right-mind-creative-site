import {
  actorMatches, authenticateSimonV3, catalog, hashJson, hasOnlyKeys, isUuid, jsonResponse,
  matchSimonV3Route, operationFromRow, parseVersion, policies, problem, resourceFromRow,
} from "../../../_lib/simon-v3.js";
import {
  calendarIsConfigured, createCalendarEvent, deleteCalendarEvent, getBusyPeriods,
  listCalendarEvents, updateCalendarEvent,
} from "../../../_lib/google-calendar.js";
import {
  createSimonPaymentCheckout, createSimonRefund, getSimonCheckout, getSimonRefund,
  expireSimonCheckout, getStripeHealth,
} from "../../../_lib/stripe.js";
import {
  deliverStagingNotificationProbe, isStagingDeliveryProbe,
} from "../../../_lib/simon-v3-notification-delivery.js";

const clean = (value, maximum = 500) => String(value || "").trim().slice(0, maximum);
const now = () => new Date().toISOString();
const CLEAN_FILE_RETENTION_POLICY = "clean-private-file-6-calendar-months-v1";

const addUtcCalendarMonths = (value, months) => {
  const source = new Date(value);
  if (Number.isNaN(source.getTime()) || !Number.isInteger(months) || months < 1) return null;
  const targetMonthIndex = source.getUTCMonth() + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear, targetMonth, Math.min(source.getUTCDate(), finalDay),
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds(),
  )).toISOString();
};

const routeId = (route) => {
  for (const key of ["client_id", "employee_id", "application_id", "booking_id", "hold_id", "assignment_id", "file_id", "notification_id"]) {
    if (route.params[key]) return route.params[key];
  }
  return null;
};

const eventStatement = (db, { eventId = crypto.randomUUID(), traceId, route, actor, resourceId = null, operationId = null, outcome, evidence = {} }) => db.prepare(`
  INSERT INTO simon_v3_events
    (id, trace_id, action, requester_person_id, requester_role, resource_kind,
      resource_id, operation_id, outcome, evidence_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  eventId, traceId, route.operationId, actor.person_id, actor.role, route.kind,
  resourceId, operationId, outcome, JSON.stringify(evidence), now(),
);

const canSee = (route, actor, row) => {
  if (!route.ownerScoped || ["admin", "system"].includes(actor.role)) return true;
  return row?.owner_person_id === actor.person_id || row?.id === actor.person_id;
};

const requireRouteAccess = (route, actor, traceId) => {
  if (!route.roles.includes(actor.role)) return problem(403, "forbidden", "This actor role cannot perform that operation", traceId);
  return null;
};

const validatePathIds = (route, traceId) => {
  for (const [name, value] of Object.entries(route.params)) {
    if (name.endsWith("_id") && !isUuid(value)) return problem(400, "validation_error", `Invalid ${name}`, traceId);
  }
  return null;
};

const readJson = async (request, traceId) => {
  try { return { value: await request.json() }; }
  catch { return { error: problem(400, "validation_error", "A valid JSON body is required", traceId) }; }
};

const loadResource = async (db, id) => db.prepare(`
  SELECT id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at
  FROM simon_v3_resources WHERE id = ?
`).bind(id).first();

const auditRead = async (context, route, actor, traceId, resourceId, outcome) => {
  if (context.shadowReadOnlyCredential) return;
  await eventStatement(context.env.APPLICATIONS_DB, { traceId, route, actor, resourceId, outcome }).run();
};

const parseAvailabilityRequest = (data) => {
  if (!hasOnlyKeys(data, ["starts_at", "ends_at", "duration_minutes"])) {
    return { error: "Availability data contains unsupported fields" };
  }
  const startsAt = new Date(data.starts_at || "");
  if (Number.isNaN(startsAt.getTime())) return { error: "starts_at must be an RFC 3339 timestamp" };
  const hasEnd = typeof data.ends_at === "string" && data.ends_at.length > 0;
  const hasDuration = data.duration_minutes !== undefined;
  if (hasEnd === hasDuration) {
    return { error: "Provide exactly one of ends_at or duration_minutes" };
  }
  let endsAt;
  if (hasDuration) {
    if (!Number.isInteger(data.duration_minutes)
        || data.duration_minutes < 30 || data.duration_minutes > 720
        || data.duration_minutes % 30 !== 0) {
      return { error: "duration_minutes must be a 30-minute increment from 30 through 720" };
    }
    endsAt = new Date(startsAt.getTime() + data.duration_minutes * 60000);
  } else {
    endsAt = new Date(data.ends_at);
    if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return { error: "ends_at must be after starts_at" };
    }
  }
  if (endsAt.getTime() - startsAt.getTime() > 12 * 60 * 60 * 1000) {
    return { error: "Availability checks cannot exceed 12 hours" };
  }
  return { startsAt, endsAt };
};

const centralParts = (date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23",
}).formatToParts(date).map((part) => [part.type, part.value]));

const publicPolicyCheck = (startsAt, endsAt) => {
  const start = centralParts(startsAt);
  const end = centralParts(endsAt);
  const startDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(startsAt);
  const endDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(endsAt);
  const startMinutes = Number(start.hour) * 60 + Number(start.minute);
  const endMinutes = Number(end.hour) * 60 + Number(end.minute);
  if (startsAt.getTime() < Date.now() + 48 * 60 * 60 * 1000) {
    return { eligible: false, reason: "minimum_notice" };
  }
  if (start.weekday === "Mon") return { eligible: false, reason: "closed_monday" };
  if (Number(start.minute) !== 0) return { eligible: false, reason: "hourly_start_required" };
  if (startDay !== endDay && endMinutes !== 0) return { eligible: false, reason: "ends_after_midnight" };
  const opensAt = start.weekday === "Sun" ? 13 * 60 : 10 * 60;
  if (startMinutes < opensAt) return { eligible: false, reason: "before_opening" };
  if (endsAt <= startsAt || (startDay === endDay && endMinutes <= startMinutes)) {
    return { eligible: false, reason: "invalid_interval" };
  }
  return { eligible: true, reason: null };
};

const checkCalendarAvailability = async (context, route, actor, traceId, data) => {
  const parsed = parseAvailabilityRequest(data);
  if (parsed.error) return problem(400, "validation_error", parsed.error, traceId);
  if (!calendarIsConfigured(context.env)) {
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(503, "provider_failure", "Staging calendar is not configured", traceId);
  }
  try {
    const busy = await getBusyPeriods(
      context.env, parsed.startsAt.toISOString(), parsed.endsAt.toISOString(),
    );
    const providerBusy = busy.some((period) => (
      parsed.startsAt < new Date(period.end) && parsed.endsAt > new Date(period.start)
    ));
    const policy = publicPolicyCheck(parsed.startsAt, parsed.endsAt);
    const available = !providerBusy && (actor.role === "admin" || actor.role === "system" || policy.eligible);
    const evidenceId = crypto.randomUUID();
    await eventStatement(context.env.APPLICATIONS_DB, {
      eventId: evidenceId, traceId, route, actor, outcome: "succeeded",
      evidence: {
        provider: "google_calendar", provider_confirmed: true,
        result: providerBusy ? "busy" : "free", private_fields_exposed: false,
      },
    }).run();
    return jsonResponse({
      items: [{
        id: crypto.randomUUID(), kind: "availability", version: 1,
        data: {
          starts_at: parsed.startsAt.toISOString(), ends_at: parsed.endsAt.toISOString(),
          available, policy_eligible: policy.eligible, policy_reason: policy.reason,
        },
        evidence_refs: [evidenceId],
      }],
      next_cursor: null,
    });
  } catch (error) {
    console.error("Simon V3 staging calendar availability failed safely", {
      error_type: clean(error?.name, 80) || "Error",
    });
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(502, "provider_failure", "Staging calendar did not confirm availability", traceId);
  }
};

const centralDayRange = (dateText) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const [year, month, day] = dateText.split("-").map(Number);
  const solve = (extraDays) => {
    const desired = Date.UTC(year, month - 1, day + extraDays, 0, 0, 0);
    let instant = desired;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      const observed = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
      );
      instant += desired - observed;
    }
    return new Date(instant);
  };
  const start = solve(0);
  const end = solve(1);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
};

const getCalendarAgenda = async (context, route, actor, traceId) => {
  const dateText = clean(new URL(context.request.url).searchParams.get("date"), 10);
  const range = centralDayRange(dateText);
  if (!range) return problem(400, "validation_error", "Agenda date must be YYYY-MM-DD", traceId);
  if (!calendarIsConfigured(context.env)) {
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(503, "provider_failure", "Staging calendar is not configured", traceId);
  }
  try {
    const events = await listCalendarEvents(context.env, {
      timeMin: range.start.toISOString(), timeMax: range.end.toISOString(),
    });
    const evidenceId = crypto.randomUUID();
    await eventStatement(context.env.APPLICATIONS_DB, {
      eventId: evidenceId, traceId, route, actor, outcome: "succeeded",
      evidence: {
        provider: "google_calendar", provider_confirmed: true,
        event_count: events.length, projection: "admin_agenda",
      },
    }).run();
    return jsonResponse({
      items: events.map((event) => ({
        id: crypto.randomUUID(), kind: "agenda", version: 1,
        data: {
          provider_event_id: clean(event.id, 1024), summary: clean(event.summary, 200),
          status: clean(event.status, 40), start: event.start || null, end: event.end || null,
        },
        evidence_refs: [evidenceId],
      })),
      next_cursor: null,
    });
  } catch (error) {
    console.error("Simon V3 staging calendar agenda failed safely", {
      error_type: clean(error?.name, 80) || "Error",
    });
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(502, "provider_failure", "Staging calendar did not confirm the agenda", traceId);
  }
};

const readSpecial = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const url = new URL(context.request.url);
  if (route.special === "catalog") return jsonResponse(catalog());
  if (route.special === "policies") return jsonResponse(policies());
  if (route.special === "health") {
    const environment = context.env.SIMON_V3_ENVIRONMENT === "production"
      ? "production" : "staging";
    const latestCalendar = await db.prepare(`
      SELECT evidence_json, created_at FROM simon_v3_events
      WHERE action = 'checkAvailability' AND outcome = 'succeeded'
      ORDER BY created_at DESC LIMIT 1
    `).first();
    let calendarVerified = false;
    if (latestCalendar) {
      try {
        const evidence = JSON.parse(latestCalendar.evidence_json || "{}");
        calendarVerified = evidence.provider === "google_calendar"
          && evidence.provider_confirmed === true;
      } catch {
        calendarVerified = false;
      }
    }
    let stripe = { state: "unreachable", mode: null };
    try {
      stripe = await getStripeHealth(context.env);
    } catch (error) {
      console.error("Simon V3 Stripe health check failed safely", {
        error_type: clean(error?.name, 80) || "Error",
      });
    }
    const items = [
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "d1", state: "ready", environment }, evidence_refs: [] },
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "google_calendar", state: calendarVerified ? "ready" : "not_verified", environment, verified_at: latestCalendar?.created_at || null }, evidence_refs: [] },
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "stripe", state: stripe.state, mode: stripe.mode, environment }, evidence_refs: [] },
    ];
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse({ items, next_cursor: null });
  }
  if (route.special === "operation") {
    const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(route.params.operation_id).first();
    if (!row) return problem(404, "not_found", "Operation not found", traceId);
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse(operationFromRow(row));
  }
  if (route.special === "events") {
    const after = clean(url.searchParams.get("after"), 40);
    const result = after
      ? await db.prepare("SELECT * FROM simon_v3_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 100").bind(after).all()
      : await db.prepare("SELECT * FROM simon_v3_events ORDER BY created_at DESC LIMIT 100").all();
    const items = (result.results || []).map((row) => ({
      id: row.id, kind: "event", version: 1,
      data: { trace_id: row.trace_id, action: row.action, requester_role: row.requester_role, resource_kind: row.resource_kind, resource_id: row.resource_id, operation_id: row.operation_id, outcome: row.outcome, evidence: JSON.parse(row.evidence_json), created_at: row.created_at },
      evidence_refs: [],
    }));
    return jsonResponse({ items, next_cursor: null });
  }
  if (route.special === "search") {
    const query = clean(url.searchParams.get("query"), 200).toLowerCase();
    if (!query) return problem(400, "validation_error", "A search query is required", traceId);
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const result = await db.prepare(`
      SELECT * FROM simon_v3_resources
      WHERE kind = 'client' AND (? = 1 OR archived = 0) AND lower(data_json) LIKE ?
      ORDER BY updated_at DESC LIMIT 25
    `).bind(includeArchived ? 1 : 0, `%${query.replace(/[\\%_]/g, "\\$&")}%`).all();
    const exact = [];
    const hints = [];
    for (const row of result.results || []) {
      const item = resourceFromRow(row);
      const values = [item.data.email, item.data.phone, item.data.name, item.data.artist_name].map((value) => clean(value, 200).toLowerCase());
      (values.includes(query) ? exact : hints).push(item);
    }
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse({ exact_matches: exact, duplicate_hints: hints });
  }
  return null;
};

const readResource = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  if (route.operationId === "getAgenda") {
    return getCalendarAgenda(context, route, actor, traceId);
  }
  if (route.operationId === "getPaymentLedger") {
    return getPaymentLedger(context, route, actor, traceId);
  }
  if (route.operationId === "findPaymentLinks") {
    return findPaymentLinks(context, route, actor, traceId);
  }
  if (route.operationId === "getAssignmentReminderState") {
    return getAssignmentReminderState(context, route, actor, traceId);
  }
  if (route.operationId === "getClientScopedView") {
    return getClientScopedView(context, route, actor, traceId);
  }
  if (route.operationId === "getEmployeeSessionView") {
    return getEmployeeSessionView(context, route, actor, traceId);
  }
  if (route.operationId === "getFileMetadata") {
    return getFileMetadata(context, route, actor, traceId);
  }
  if (route.operationId === "listFilesDueForRetention") {
    return listFilesDueForRetention(context, route, actor, traceId);
  }
  if (route.provider) {
    await auditRead(context, route, actor, traceId, routeId(route), "failed");
    return problem(502, "provider_failure", `${route.provider} read has no verified staging receipt`, traceId, "No provider result was represented as successful.");
  }
  const id = routeId(route);
  if (id) {
    const row = await loadResource(db, id);
    if (!row || row.kind !== route.kind || Number(row.archived)) return problem(404, "not_found", "Resource not found", traceId);
    if (!canSee(route, actor, row)) return problem(403, "forbidden", "The resource is outside this actor's scope", traceId);
    await auditRead(context, route, actor, traceId, id, "succeeded");
    return jsonResponse(resourceFromRow(row), 200, { etag: `"${row.version}"` });
  }
  const state = clean(new URL(context.request.url).searchParams.get("state"), 100);
  const ownerClause = route.ownerScoped && !["admin", "system"].includes(actor.role) ? " AND owner_person_id = ?" : "";
  const stateClause = state ? " AND state = ?" : "";
  const bindings = [route.kind];
  if (ownerClause) bindings.push(actor.person_id);
  if (stateClause) bindings.push(state);
  const result = await db.prepare(`
    SELECT * FROM simon_v3_resources WHERE kind = ? AND archived = 0${ownerClause}${stateClause}
    ORDER BY updated_at DESC LIMIT 100
  `).bind(...bindings).all();
  await auditRead(context, route, actor, traceId, null, "succeeded");
  return jsonResponse({ items: (result.results || []).map(resourceFromRow), next_cursor: null });
};

const stateFor = (operationId, data, current) => ({
  archiveClient: "archived", restoreClient: "active", deactivateEmployee: "inactive",
  restoreEmployee: "active", createApplicationDraft: "draft", submitApplication: "submitted",
  declineApplication: "declined", cancelBooking: "cancelled", restoreBooking: "confirmed",
  cancelCalendarHold: "cancelled", respondToAssignment: data.response || data.state || "responded",
}[operationId] || current || "active");

const existingOperation = async (db, key, requestHash, traceId) => {
  const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE idempotency_key = ?").bind(key).first();
  if (!row) return null;
  if (row.request_hash !== requestHash) return { error: problem(409, "version_conflict", "Idempotency key was used for a different request", traceId) };
  if (row.status === "failed") {
    return { error: problem(502, "provider_failure", "The provider did not confirm the operation", row.trace_id, "Retry only after staging provider configuration is verified.", { operation_id: row.id }) };
  }
  return { response: jsonResponse(operationFromRow(row), 202) };
};

const failedProviderOperation = async (context, route, actor, traceId, key, requestHash) => {
  const id = crypto.randomUUID();
  const timestamp = now();
  const step = [{ name: route.operationId, status: "failed", provider_confirmed: false, provider_receipt_ref: null, retry_safe: true, error: { code: "provider_failure", provider: route.provider } }];
  await context.env.APPLICATIONS_DB.batch([
    context.env.APPLICATIONS_DB.prepare(`
      INSERT INTO simon_v3_operations
        (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role,
          status, resource_refs_json, steps_json, rollback_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', '[]', ?, '{"available":false}', ?, ?)
    `).bind(id, route.operationId, key, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(step), timestamp, timestamp),
    eventStatement(context.env.APPLICATIONS_DB, { traceId, route, actor, operationId: id, outcome: "failed", evidence: { provider: route.provider, provider_confirmed: false } }),
  ]);
  return problem(502, "provider_failure", `${route.provider} did not confirm the operation`, traceId, "No provider action was represented as successful.", { operation_id: id });
};

const calendarHoldInput = (data) => {
  if (!hasOnlyKeys(data, ["id", "summary", "starts_at", "ends_at", "start_date", "end_date", "recurrence"])) {
    return { error: "Calendar hold data contains unsupported fields" };
  }
  const id = data.id ? String(data.id) : crypto.randomUUID();
  const summary = clean(data.summary, 120);
  if (!isUuid(id)) return { error: "Calendar hold id must be a UUID" };
  if (!summary) return { error: "Calendar hold summary is required" };
  const timed = Boolean(data.starts_at || data.ends_at);
  const allDay = Boolean(data.start_date || data.end_date);
  if (timed === allDay) return { error: "Provide either timed or all-day hold dates" };
  let start;
  let end;
  let storedSchedule;
  if (timed) {
    const startsAt = new Date(data.starts_at || "");
    const endsAt = new Date(data.ends_at || "");
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return { error: "Calendar hold start and end must be valid ordered timestamps" };
    }
    if (endsAt.getTime() - startsAt.getTime() > 31 * 24 * 60 * 60 * 1000) {
      return { error: "Timed calendar holds cannot exceed 31 days" };
    }
    start = { dateTime: startsAt.toISOString(), timeZone: "America/Chicago" };
    end = { dateTime: endsAt.toISOString(), timeZone: "America/Chicago" };
    storedSchedule = { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
  } else {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(String(data.start_date || ""))
        || !datePattern.test(String(data.end_date || ""))
        || data.end_date <= data.start_date) {
      return { error: "All-day hold dates must be ordered YYYY-MM-DD values with an exclusive end" };
    }
    const span = Date.parse(`${data.end_date}T00:00:00Z`) - Date.parse(`${data.start_date}T00:00:00Z`);
    if (!Number.isFinite(span) || span > 366 * 24 * 60 * 60 * 1000) {
      return { error: "All-day calendar holds cannot exceed 366 days" };
    }
    start = { date: data.start_date };
    end = { date: data.end_date };
    storedSchedule = { start_date: data.start_date, end_date: data.end_date };
  }
  let recurrence = null;
  let googleRecurrence;
  if (data.recurrence !== undefined && data.recurrence !== null) {
    if (!hasOnlyKeys(data.recurrence, ["frequency", "interval", "count"])) {
      return { error: "Calendar hold recurrence contains unsupported fields" };
    }
    const frequency = clean(data.recurrence.frequency, 16).toUpperCase();
    const interval = Number(data.recurrence.interval || 1);
    const count = Number(data.recurrence.count);
    if (!["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)
        || !Number.isInteger(interval) || interval < 1 || interval > 12
        || !Number.isInteger(count) || count < 2 || count > 52) {
      return { error: "Recurrence requires DAILY, WEEKLY, or MONTHLY with safe interval and count" };
    }
    recurrence = { frequency: frequency.toLowerCase(), interval, count };
    googleRecurrence = [`RRULE:FREQ=${frequency};INTERVAL=${interval};COUNT=${count}`];
  }
  return { id, summary, start, end, storedSchedule, recurrence, googleRecurrence };
};

const beginProviderOperation = async (
  db, { id, route, key, requestHash, traceId, actor, resourceRefs = [], before = null },
) => {
  const timestamp = now();
  const steps = [{
    name: route.operationId, status: "pending", provider_confirmed: false,
    provider_receipt_ref: null, retry_safe: false, error: null,
  }];
  await db.batch([
    db.prepare(`INSERT INTO simon_v3_operations
      (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role,
       status, resource_refs_json, steps_json, rollback_json, before_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '{"available":false}', ?, ?)`)
      .bind(id, route.operationId, key, requestHash, traceId, actor.person_id, actor.role,
        JSON.stringify(resourceRefs), JSON.stringify(steps), before, timestamp),
    eventStatement(db, {
      traceId, route, actor, resourceId: resourceRefs[0]?.id || null,
      operationId: id, outcome: "pending", evidence: { provider: route.provider || "website" },
    }),
  ]);
  return timestamp;
};

const failProviderOperation = async (db, { id, route, actor, traceId, resourceId }) => {
  const timestamp = now();
  const steps = [{
    name: route.operationId, status: "failed", provider_confirmed: false,
    provider_receipt_ref: null, retry_safe: false,
    error: { code: "provider_failure", provider: route.provider || "website" },
  }];
  try {
    await db.batch([
      db.prepare(`UPDATE simon_v3_operations
        SET status = 'failed', steps_json = ?, completed_at = ? WHERE id = ?`)
        .bind(JSON.stringify(steps), timestamp, id),
      eventStatement(db, {
        traceId, route, actor, resourceId, operationId: id, outcome: "failed",
        evidence: { provider: route.provider || "website", provider_confirmed: false },
      }),
    ]);
  } catch {
    // The durable pending row, if reachable, remains honest and reconcilable.
  }
};

const mutateCalendarHold = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!calendarIsConfigured(context.env)) {
    return failedProviderOperation(context, route, actor, traceId, key, requestHash);
  }
  const operationId = crypto.randomUUID();
  const timestamp = now();
  if (route.operationId === "createCalendarHold") {
    const input = calendarHoldInput(body.data);
    if (input.error) return problem(400, "validation_error", input.error, traceId);
    const eventHash = await hashJson({ idempotency_key: key });
    const providerEventId = `simon${eventHash.slice(0, 48)}`;
    const resourceRefs = [{ kind: "calendar_hold", id: input.id, version: 1 }];
    await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs,
    });
    try {
      const event = await createCalendarEvent(context.env, {
        id: providerEventId,
        summary: input.summary,
        start: input.start,
        end: input.end,
        ...(input.googleRecurrence ? { recurrence: input.googleRecurrence } : {}),
        transparency: "opaque",
        extendedProperties: { private: { simonV3ResourceId: input.id, requestHash } },
      });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") {
        throw new Error("Google Calendar returned an invalid creation receipt.");
      }
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = {
        id: input.id, summary: input.summary, ...input.storedSchedule,
        recurrence: input.recurrence, provider_event_id: event.id, state: "active",
      };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: receipt, retry_safe: true, error: null,
      }];
      const after = JSON.stringify({
        state: "active", owner_person_id: actor.person_id,
        data_json: JSON.stringify(data), archived: 0,
      });
      await db.batch([
        db.prepare(`INSERT INTO simon_v3_resources
          (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
          VALUES (?, 'calendar_hold', 1, 'active', ?, ?, 0, ?, ?)`)
          .bind(input.id, actor.person_id, JSON.stringify(data), timestamp, timestamp),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(resourceRefs), JSON.stringify(steps), after, now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: input.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, receipt },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      console.error("Simon V3 calendar hold creation failed safely", {
        operationId, error_type: clean(error?.name, 80) || "Error",
      });
      try {
        await deleteCalendarEvent(context.env, providerEventId);
      } catch {
        // The deterministic provider ID remains available for reconciliation.
      }
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: input.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm the hold", traceId, "No calendar hold was represented as successful.", { operation_id: operationId });
    }
  }
  if (route.operationId === "updateCalendarHold") {
    if (!current || current.state !== "active") {
      return problem(409, "invalid_transition", "Calendar hold is not active", traceId);
    }
    if (!hasOnlyKeys(body.data, ["summary", "starts_at", "ends_at", "start_date", "end_date", "recurrence"])) {
      return problem(400, "validation_error", "Calendar hold update contains unsupported fields", traceId);
    }
    const currentData = JSON.parse(current.data_json);
    const candidate = { ...currentData, ...body.data, id: current.id };
    if (body.data.starts_at !== undefined || body.data.ends_at !== undefined) {
      delete candidate.start_date;
      delete candidate.end_date;
    }
    if (body.data.start_date !== undefined || body.data.end_date !== undefined) {
      delete candidate.starts_at;
      delete candidate.ends_at;
    }
    delete candidate.provider_event_id;
    delete candidate.state;
    const input = calendarHoldInput(candidate);
    if (input.error) return problem(400, "validation_error", input.error, traceId);
    const providerEventId = clean(currentData.provider_event_id, 1024);
    if (!providerEventId) return problem(409, "invalid_transition", "Calendar hold lacks provider evidence", traceId);
    const version = Number(current.version) + 1;
    const resourceRefs = [{ kind: "calendar_hold", id: current.id, version }];
    const before = JSON.stringify({
      state: current.state, owner_person_id: current.owner_person_id,
      data_json: current.data_json, archived: current.archived,
    });
    await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs, before,
    });
    try {
      const event = await updateCalendarEvent(context.env, providerEventId, {
        summary: input.summary, start: input.start, end: input.end,
        recurrence: input.googleRecurrence || [],
      });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") {
        throw new Error("Google Calendar returned an invalid update receipt.");
      }
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = {
        id: current.id, summary: input.summary, ...input.storedSchedule,
        recurrence: input.recurrence, provider_event_id: event.id, state: "active",
      };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: receipt, retry_safe: true, error: null,
      }];
      const after = JSON.stringify({
        state: "active", owner_person_id: current.owner_person_id,
        data_json: JSON.stringify(data), archived: current.archived,
      });
      await db.batch([
        db.prepare(`UPDATE simon_v3_resources SET version = ?, data_json = ?, updated_at = ?
          WHERE id = ?`).bind(version, JSON.stringify(data), now(), current.id),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(resourceRefs), JSON.stringify(steps), after, now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, receipt },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      console.error("Simon V3 calendar hold update failed safely", {
        operationId, error_type: clean(error?.name, 80) || "Error",
      });
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm the hold update", traceId, "The original V3 record was preserved; reconcile the provider event before retry.", { operation_id: operationId });
    }
  }
  if (route.operationId === "cancelCalendarHold") {
    if (!current || current.state === "cancelled") {
      return problem(409, "invalid_transition", "Calendar hold is not active", traceId);
    }
    const currentData = JSON.parse(current.data_json);
    const providerEventId = clean(currentData.provider_event_id, 1024);
    if (!providerEventId) return problem(409, "invalid_transition", "Calendar hold lacks provider evidence", traceId);
    const resourceRefs = [{ kind: "calendar_hold", id: current.id, version: Number(current.version) + 1 }];
    const before = JSON.stringify({
      state: current.state, owner_person_id: current.owner_person_id,
      data_json: current.data_json, archived: current.archived,
    });
    await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs, before,
    });
    try {
      const receipt = await deleteCalendarEvent(context.env, providerEventId);
      const data = { ...currentData, state: "cancelled" };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: `${providerEventId}:${receipt.status}`,
        retry_safe: true, error: null,
      }];
      const after = JSON.stringify({
        state: "cancelled", owner_person_id: current.owner_person_id,
        data_json: JSON.stringify(data), archived: current.archived,
      });
      await db.batch([
        db.prepare(`UPDATE simon_v3_resources SET version = ?, state = 'cancelled',
          data_json = ?, updated_at = ? WHERE id = ?`)
          .bind(Number(current.version) + 1, JSON.stringify(data), now(), current.id),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(resourceRefs), JSON.stringify(steps), after, now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, action: "deleted" },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      console.error("Simon V3 calendar hold cancellation failed safely", {
        operationId, error_type: clean(error?.name, 80) || "Error",
      });
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm hold cancellation", traceId, "The operation requires reconciliation before retry.", { operation_id: operationId });
    }
  }
  return failedProviderOperation(context, route, actor, traceId, key, requestHash);
};

const bookingInput = (data) => {
  if (!hasOnlyKeys(data, [
    "id", "owner_person_id", "application_id", "summary", "service_id",
    "starts_at", "ends_at", "payment_state", "agreed_total_minor", "currency",
  ])) return { error: "Booking data contains unsupported fields" };
  const id = data.id ? String(data.id) : crypto.randomUUID();
  const owner = String(data.owner_person_id || "");
  const applicationId = data.application_id ? String(data.application_id) : null;
  const summary = clean(data.summary, 200);
  const serviceId = clean(data.service_id, 100);
  const startsAt = new Date(data.starts_at || "");
  const endsAt = new Date(data.ends_at || "");
  const paymentState = clean(data.payment_state, 40);
  const total = Number(data.agreed_total_minor);
  if (!isUuid(id) || !isUuid(owner) || (applicationId && !isUuid(applicationId))) {
    return { error: "Booking, owner, and application identifiers must be UUIDs" };
  }
  if (!summary || !serviceId) return { error: "Booking summary and service are required" };
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return { error: "Booking start and end must be valid ordered timestamps" };
  }
  if (endsAt.getTime() - startsAt.getTime() > 12 * 60 * 60 * 1000) {
    return { error: "Scheduled bookings cannot exceed 12 hours" };
  }
  if (!["deposit_pending", "deposit_waived", "deposit_paid"].includes(paymentState)) {
    return { error: "Booking payment state is invalid" };
  }
  if (!Number.isInteger(total) || total < 0 || data.currency !== "USD") {
    return { error: "Booking requires an exact non-negative USD price snapshot" };
  }
  return {
    id, owner, applicationId, summary, serviceId, startsAt, endsAt,
    paymentState, total, bookingState: paymentState === "deposit_pending" ? "held" : "booked",
  };
};

const mutateBooking = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!calendarIsConfigured(context.env)) {
    return failedProviderOperation(context, route, actor, traceId, key, requestHash);
  }
  const operationId = crypto.randomUUID();
  if (route.operationId === "createBooking") {
    const input = bookingInput(body.data);
    if (input.error) return problem(400, "validation_error", input.error, traceId);
    const busy = await getBusyPeriods(
      context.env, input.startsAt.toISOString(), input.endsAt.toISOString(),
    );
    if (busy.some((period) => (
      input.startsAt < new Date(period.end) && input.endsAt > new Date(period.start)
    ))) return problem(409, "invalid_transition", "The complete booking duration is unavailable", traceId);
    const providerEventId = `simon${(await hashJson({ idempotency_key: key })).slice(0, 48)}`;
    const resourceRefs = [{ kind: "booking", id: input.id, version: 1 }];
    const timestamp = await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs,
    });
    try {
      const event = await createCalendarEvent(context.env, {
        id: providerEventId, summary: input.summary,
        start: { dateTime: input.startsAt.toISOString(), timeZone: "America/Chicago" },
        end: { dateTime: input.endsAt.toISOString(), timeZone: "America/Chicago" },
        transparency: "opaque",
        extendedProperties: { private: { simonV3ResourceId: input.id, requestHash } },
      });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") {
        throw new Error("Google Calendar returned an invalid booking receipt.");
      }
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = {
        id: input.id, owner_person_id: input.owner, application_id: input.applicationId,
        summary: input.summary, service_id: input.serviceId,
        starts_at: input.startsAt.toISOString(), ends_at: input.endsAt.toISOString(),
        payment_state: input.paymentState, booking_state: input.bookingState,
        agreed_total_minor: input.total, currency: "USD", provider_event_id: event.id,
      };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: receipt, retry_safe: true, error: null,
      }];
      const after = JSON.stringify({
        state: input.bookingState, owner_person_id: input.owner,
        data_json: JSON.stringify(data), archived: 0,
      });
      await db.batch([
        db.prepare(`INSERT INTO simon_v3_resources
          (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
          VALUES (?, 'booking', 1, ?, ?, ?, 0, ?, ?)`)
          .bind(input.id, input.bookingState, input.owner, JSON.stringify(data), timestamp, timestamp),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(resourceRefs), JSON.stringify(steps), after, now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: input.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, receipt },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      try { await deleteCalendarEvent(context.env, providerEventId); } catch { /* reconcile by ID */ }
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: input.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm the booking", traceId, "No booking was represented as successful.", { operation_id: operationId });
    }
  }
  if (route.operationId === "cancelBooking") {
    if (!current || current.state === "cancelled") {
      return problem(409, "invalid_transition", "Booking is not active", traceId);
    }
    const currentData = JSON.parse(current.data_json);
    const refundChoice = body.data.refund_choice || null;
    if (currentData.payment_state === "deposit_paid" && !["full", "partial", "none"].includes(refundChoice)) {
      return problem(409, "invalid_transition", "Paid cancellation requires full, partial, or no-refund choice", traceId);
    }
    if (["full", "partial"].includes(refundChoice)) {
      return problem(409, "invalid_transition", "Complete the verified Stripe refund before calendar cancellation", traceId);
    }
    const providerEventId = clean(currentData.provider_event_id, 1024);
    const ledgerBookingId = clean(currentData.payment_ledger_booking_id, 36) || current.id;
    const unpaidResult = await db.prepare(`SELECT * FROM simon_v3_resources
      WHERE kind = 'payment_link' AND json_extract(data_json, '$.booking_id') = ?
        AND state = 'unpaid' ORDER BY created_at ASC`).bind(ledgerBookingId).all();
    const unpaidLinks = unpaidResult.results || [];
    const version = Number(current.version) + 1;
    const refs = [{ kind: "booking", id: current.id, version }, ...unpaidLinks.map((link) => ({
      kind: "payment_link", id: link.id, version: Number(link.version) + 1,
    }))];
    const before = JSON.stringify({
      state: current.state, owner_person_id: current.owner_person_id,
      data_json: current.data_json, archived: current.archived,
    });
    await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs, before,
    });
    try {
      const steps = [];
      const linkStatements = [];
      for (const link of unpaidLinks) {
        const linkData = JSON.parse(link.data_json);
        const expired = await expireSimonCheckout(context.env, linkData.stripe_checkout_session_id, `${key}-expire-${link.id}`);
        if (expired.status !== "expired" || expired.livemode !== false) throw new Error("Stripe did not confirm payment-link expiration.");
        const cancelledLink = { ...linkData, state: "cancelled", cancelled_at: now() };
        linkStatements.push(db.prepare("UPDATE simon_v3_resources SET version = ?, state = 'cancelled', data_json = ?, updated_at = ? WHERE id = ?")
          .bind(Number(link.version) + 1, JSON.stringify(cancelledLink), now(), link.id));
        steps.push({ name: "expire_payment_link", status: "succeeded", provider_confirmed: true, provider_receipt_ref: expired.id, retry_safe: true, error: null });
      }
      const receipt = await deleteCalendarEvent(context.env, providerEventId);
      const data = { ...currentData, booking_state: "cancelled" };
      steps.push({
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: `${providerEventId}:${receipt.status}`,
        retry_safe: true, error: null,
      });
      await db.batch([
        ...linkStatements,
        db.prepare(`UPDATE simon_v3_resources SET version = ?, state = 'cancelled', data_json = ?,
          updated_at = ? WHERE id = ?`).bind(version, JSON.stringify(data), now(), current.id),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify({
            state: "cancelled", owner_person_id: current.owner_person_id,
            data_json: JSON.stringify(data), archived: current.archived,
          }), now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, action: "deleted" },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm booking cancellation", traceId, "The operation requires reconciliation before retry.", { operation_id: operationId });
    }
  }
  if (route.operationId === "rescheduleBooking") {
    if (!current || current.state === "cancelled") {
      return problem(409, "invalid_transition", "Cancelled booking requires explicit restoration", traceId);
    }
    if (!hasOnlyKeys(body.data, ["starts_at", "ends_at"])) {
      return problem(400, "validation_error", "Reschedule requires only start and end", traceId);
    }
    const startsAt = new Date(body.data.starts_at || "");
    const endsAt = new Date(body.data.ends_at || "");
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())
        || endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 12 * 60 * 60 * 1000) {
      return problem(400, "validation_error", "Reschedule requires a valid complete duration", traceId);
    }
    const busy = await getBusyPeriods(context.env, startsAt.toISOString(), endsAt.toISOString());
    if (busy.some((period) => startsAt < new Date(period.end) && endsAt > new Date(period.start))) {
      return problem(409, "invalid_transition", "The complete reschedule duration is unavailable", traceId);
    }
    const currentData = JSON.parse(current.data_json);
    const providerEventId = clean(currentData.provider_event_id, 1024);
    const version = Number(current.version) + 1;
    const refs = [{ kind: "booking", id: current.id, version }];
    const before = JSON.stringify({
      state: current.state, owner_person_id: current.owner_person_id,
      data_json: current.data_json, archived: current.archived,
    });
    await beginProviderOperation(db, {
      id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs, before,
    });
    try {
      const event = await updateCalendarEvent(context.env, providerEventId, {
        start: { dateTime: startsAt.toISOString(), timeZone: "America/Chicago" },
        end: { dateTime: endsAt.toISOString(), timeZone: "America/Chicago" },
      });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") {
        throw new Error("Google Calendar returned an invalid reschedule receipt.");
      }
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = {
        ...currentData, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
      };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: receipt, retry_safe: true, error: null,
      }];
      await db.batch([
        db.prepare(`UPDATE simon_v3_resources SET version = ?, data_json = ?, updated_at = ?
          WHERE id = ?`).bind(version, JSON.stringify(data), now(), current.id),
        db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
          steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify({
            state: current.state, owner_person_id: current.owner_person_id,
            data_json: JSON.stringify(data), archived: current.archived,
          }), now(), operationId),
        eventStatement(db, {
          traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded",
          evidence: { provider: "google_calendar", provider_confirmed: true, receipt },
        }),
      ]);
      const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
        .bind(operationId).first();
      return jsonResponse(operationFromRow(row), 202);
    } catch (error) {
      await failProviderOperation(db, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(502, "provider_failure", "Google Calendar did not confirm the reschedule", traceId, "The original V3 booking record was preserved; reconcile the provider before retry.", { operation_id: operationId });
    }
  }
  if (route.operationId === "splitBooking") {
    if (!current || current.state === "cancelled") {
      return problem(409, "invalid_transition", "Cancelled booking requires explicit restoration", traceId);
    }
    if (!hasOnlyKeys(body.data, [
      "first_duration_minutes", "second_starts_at", "second_duration_minutes", "second_booking_id",
    ])) return problem(400, "validation_error", "Booking split contains unsupported fields", traceId);
    const currentData = JSON.parse(current.data_json);
    const originalStart = new Date(currentData.starts_at || "");
    const originalEnd = new Date(currentData.ends_at || "");
    const firstMinutes = Number(body.data.first_duration_minutes);
    const secondMinutes = Number(body.data.second_duration_minutes);
    const secondStart = new Date(body.data.second_starts_at || "");
    const originalMinutes = (originalEnd.getTime() - originalStart.getTime()) / 60000;
    if (!Number.isInteger(firstMinutes) || !Number.isInteger(secondMinutes)
        || firstMinutes < 30 || secondMinutes < 30
        || firstMinutes % 30 !== 0 || secondMinutes % 30 !== 0
        || firstMinutes + secondMinutes !== originalMinutes
        || Number.isNaN(secondStart.getTime())) {
      return problem(400, "validation_error", "Split durations must be positive half-hour increments that preserve the original duration", traceId);
    }
    const firstEnd = new Date(originalStart.getTime() + firstMinutes * 60000);
    const secondEnd = new Date(secondStart.getTime() + secondMinutes * 60000);
    if (secondStart < firstEnd) {
      return problem(400, "validation_error", "The second booking cannot overlap the first booking", traceId);
    }
    const busy = await getBusyPeriods(context.env, secondStart.toISOString(), secondEnd.toISOString());
    if (busy.some((period) => secondStart < new Date(period.end) && secondEnd > new Date(period.start))) {
      return problem(409, "invalid_transition", "The complete second booking duration is unavailable", traceId);
    }
    const secondId = body.data.second_booking_id ? String(body.data.second_booking_id) : crypto.randomUUID();
    if (!isUuid(secondId) || await loadResource(db, secondId)) {
      return problem(409, "invalid_transition", "The second booking identifier is invalid or already exists", traceId);
    }
    const firstProviderId = clean(currentData.provider_event_id, 1024);
    if (!firstProviderId) return problem(409, "invalid_transition", "Booking lacks provider evidence", traceId);
    const secondProviderId = `simon${(await hashJson({ idempotency_key: key, segment: 2 })).slice(0, 48)}`;
    const firstVersion = Number(current.version) + 1;
    const refs = [
      { kind: "booking", id: current.id, version: firstVersion },
      { kind: "booking", id: secondId, version: 1 },
    ];
    const before = JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: current.data_json, archived: current.archived });
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs, before });
    try {
      const firstEvent = await updateCalendarEvent(context.env, firstProviderId, {
        end: { dateTime: firstEnd.toISOString(), timeZone: "America/Chicago" },
      });
      if (!firstEvent?.id || firstEvent.id !== firstProviderId || firstEvent.status === "cancelled") throw new Error("Invalid first split receipt.");
      const secondEvent = await createCalendarEvent(context.env, {
        id: secondProviderId, summary: `${currentData.summary} (Part 2)`,
        start: { dateTime: secondStart.toISOString(), timeZone: "America/Chicago" },
        end: { dateTime: secondEnd.toISOString(), timeZone: "America/Chicago" }, transparency: "opaque",
        extendedProperties: { private: { simonV3ResourceId: secondId, splitFromBookingId: current.id, requestHash } },
      });
      if (!secondEvent?.id || secondEvent.id !== secondProviderId || secondEvent.status === "cancelled") throw new Error("Invalid second split receipt.");
      const ledgerBookingId = currentData.payment_ledger_booking_id || current.id;
      const firstData = {
        ...currentData, ends_at: firstEnd.toISOString(), duration_minutes: firstMinutes,
        payment_ledger_booking_id: ledgerBookingId, split_child_booking_id: secondId,
      };
      const secondData = {
        ...currentData, id: secondId, summary: `${currentData.summary} (Part 2)`,
        starts_at: secondStart.toISOString(), ends_at: secondEnd.toISOString(),
        duration_minutes: secondMinutes, provider_event_id: secondEvent.id,
        agreed_total_minor: 0, payment_ledger_booking_id: ledgerBookingId,
        split_parent_booking_id: current.id,
      };
      const steps = [
        { name: "shorten_original_booking", status: "succeeded", provider_confirmed: true, provider_receipt_ref: `${firstEvent.id}:${clean(firstEvent.etag, 160) || "confirmed"}`, retry_safe: true, error: null },
        { name: "create_second_booking", status: "succeeded", provider_confirmed: true, provider_receipt_ref: `${secondEvent.id}:${clean(secondEvent.etag, 160) || "confirmed"}`, retry_safe: true, error: null },
      ];
      await db.batch([
        db.prepare("UPDATE simon_v3_resources SET version = ?, data_json = ?, updated_at = ? WHERE id = ?").bind(firstVersion, JSON.stringify(firstData), now(), current.id),
        db.prepare(`INSERT INTO simon_v3_resources
          (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
          VALUES (?, 'booking', 1, ?, ?, ?, 0, ?, ?)`).bind(secondId, current.state, current.owner_person_id, JSON.stringify(secondData), timestamp, timestamp),
        db.prepare("UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?, steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?")
          .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify({ split: true, first: firstData, second: secondData }), now(), operationId),
        eventStatement(db, { traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded", evidence: { provider: "google_calendar", provider_confirmed: true, split_booking_id: secondId } }),
      ]);
      return jsonResponse(operationFromRow(await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(operationId).first()), 202);
    } catch (error) {
      try { await deleteCalendarEvent(context.env, secondProviderId); } catch { /* deterministic reconciliation ID */ }
      try {
        await updateCalendarEvent(context.env, firstProviderId, {
          start: { dateTime: originalStart.toISOString(), timeZone: "America/Chicago" },
          end: { dateTime: originalEnd.toISOString(), timeZone: "America/Chicago" },
        });
      } catch { /* operation remains failed and requires reconciliation */ }
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: current.id });
      return problem(502, "provider_failure", "Google Calendar did not confirm the complete booking split", traceId, "The split was compensated where possible and requires reconciliation before retry.", { operation_id: operationId });
    }
  }
  if (route.operationId === "updateBooking") {
    if (!current || current.state === "cancelled") {
      return problem(409, "invalid_transition", "Cancelled booking requires explicit restoration", traceId);
    }
    if (!hasOnlyKeys(body.data, ["summary", "service_id"])) {
      return problem(400, "validation_error", "Booking edit may change only summary or service", traceId);
    }
    const currentData = JSON.parse(current.data_json);
    const summary = body.data.summary === undefined ? currentData.summary : clean(body.data.summary, 200);
    const serviceId = body.data.service_id === undefined ? currentData.service_id : clean(body.data.service_id, 100);
    if (!summary || !serviceId) return problem(400, "validation_error", "Booking summary and service are required", traceId);
    const providerEventId = clean(currentData.provider_event_id, 1024);
    const version = Number(current.version) + 1;
    const refs = [{ kind: "booking", id: current.id, version }];
    const before = JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: current.data_json, archived: current.archived });
    await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs, before });
    try {
      const event = await updateCalendarEvent(context.env, providerEventId, { summary });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") throw new Error("Invalid booking update receipt.");
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = { ...currentData, summary, service_id: serviceId };
      const steps = [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: receipt, retry_safe: true, error: null }];
      await db.batch([
        db.prepare("UPDATE simon_v3_resources SET version = ?, data_json = ?, updated_at = ? WHERE id = ?").bind(version, JSON.stringify(data), now(), current.id),
        db.prepare("UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?, steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?")
          .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: JSON.stringify(data), archived: current.archived }), now(), operationId),
        eventStatement(db, { traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded", evidence: { provider: "google_calendar", provider_confirmed: true, receipt } }),
      ]);
      return jsonResponse(operationFromRow(await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(operationId).first()), 202);
    } catch (error) {
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: current.id });
      return problem(502, "provider_failure", "Google Calendar did not confirm the booking edit", traceId, "The original V3 record was preserved; reconcile the provider before retry.", { operation_id: operationId });
    }
  }
  if (route.operationId === "restoreBooking") {
    if (!current || current.state !== "cancelled") return problem(409, "invalid_transition", "Only a cancelled booking can be restored", traceId);
    if (!hasOnlyKeys(body.data, ["starts_at", "ends_at"])) return problem(400, "validation_error", "Restore requires a fresh start and end", traceId);
    const startsAt = new Date(body.data.starts_at || "");
    const endsAt = new Date(body.data.ends_at || "");
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 12 * 60 * 60 * 1000) {
      return problem(400, "validation_error", "Restore requires a valid complete duration", traceId);
    }
    const busy = await getBusyPeriods(context.env, startsAt.toISOString(), endsAt.toISOString());
    if (busy.some((period) => startsAt < new Date(period.end) && endsAt > new Date(period.start))) return problem(409, "invalid_transition", "The complete restore duration is unavailable", traceId);
    const currentData = JSON.parse(current.data_json);
    const providerEventId = `simon${(await hashJson({ idempotency_key: key })).slice(0, 48)}`;
    const state = currentData.payment_state === "deposit_pending" ? "held" : "booked";
    const version = Number(current.version) + 1;
    const refs = [{ kind: "booking", id: current.id, version }];
    const before = JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: current.data_json, archived: current.archived });
    await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs, before });
    try {
      const event = await createCalendarEvent(context.env, {
        id: providerEventId, summary: currentData.summary,
        start: { dateTime: startsAt.toISOString(), timeZone: "America/Chicago" },
        end: { dateTime: endsAt.toISOString(), timeZone: "America/Chicago" }, transparency: "opaque",
        extendedProperties: { private: { simonV3ResourceId: current.id, requestHash } },
      });
      if (!event?.id || event.id !== providerEventId || event.status === "cancelled") throw new Error("Invalid booking restore receipt.");
      const receipt = `${event.id}:${clean(event.etag, 160) || "confirmed"}`;
      const data = { ...currentData, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), provider_event_id: event.id, booking_state: state };
      const steps = [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: receipt, retry_safe: true, error: null }];
      await db.batch([
        db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, data_json = ?, updated_at = ? WHERE id = ?").bind(version, state, JSON.stringify(data), now(), current.id),
        db.prepare("UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?, steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?")
          .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify({ state, owner_person_id: current.owner_person_id, data_json: JSON.stringify(data), archived: current.archived }), now(), operationId),
        eventStatement(db, { traceId, route, actor, resourceId: current.id, operationId, outcome: "succeeded", evidence: { provider: "google_calendar", provider_confirmed: true, receipt } }),
      ]);
      return jsonResponse(operationFromRow(await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(operationId).first()), 202);
    } catch (error) {
      try { await deleteCalendarEvent(context.env, providerEventId); } catch { /* reconcile by deterministic ID */ }
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: current.id });
      return problem(502, "provider_failure", "Google Calendar did not confirm booking restoration", traceId, "The booking remains cancelled.", { operation_id: operationId });
    }
  }
  return failedProviderOperation(context, route, actor, traceId, key, requestHash);
};

const ledgerKinds = new Set([
  "add_on", "overtime", "discount", "credit", "deposit_payment", "payment", "refund",
]);

const loadLedger = async (db, bookingId) => {
  const requested = await loadResource(db, bookingId);
  if (!requested || requested.kind !== "booking") return null;
  const requestedData = JSON.parse(requested.data_json);
  const rootId = clean(requestedData.payment_ledger_booking_id, 36) || requested.id;
  const booking = rootId === requested.id ? requested : await loadResource(db, rootId);
  if (!booking || booking.kind !== "booking") return null;
  const bookingData = JSON.parse(booking.data_json);
  const result = await db.prepare(`
    SELECT * FROM simon_v3_resources
    WHERE kind = 'ledger_entry' AND json_extract(data_json, '$.booking_id') = ?
    ORDER BY created_at ASC
  `).bind(rootId).all();
  const entries = (result.results || []).map((row) => resourceFromRow(row));
  let remaining = Number(bookingData.agreed_total_minor || 0);
  for (const entry of entries) {
    const amount = Number(entry.data.amount_minor || 0);
    remaining += ["add_on", "overtime", "refund"].includes(entry.data.entry_kind) ? amount : -amount;
  }
  return {
    booking, bookingData, rootId, entries,
    agreedTotal: Number(bookingData.agreed_total_minor || 0),
    remaining: Math.max(0, remaining),
  };
};

const getPaymentLedger = async (context, route, actor, traceId) => {
  const ledger = await loadLedger(context.env.APPLICATIONS_DB, route.params.booking_id);
  if (!ledger) return problem(404, "not_found", "Booking payment ledger not found", traceId);
  if (!canSee(route, actor, ledger.booking)) return problem(403, "forbidden", "The payment ledger is outside this actor's scope", traceId);
  await auditRead(context, route, actor, traceId, ledger.rootId, "succeeded");
  return jsonResponse({
    id: ledger.rootId, kind: "payment_ledger", version: ledger.entries.length + 1,
    data: {
      booking_id: ledger.rootId, client_person_id: ledger.booking.owner_person_id,
      agreed_total_minor: ledger.agreedTotal, currency: "USD",
      remaining_minor: ledger.remaining, entries: ledger.entries.map((entry) => entry.data),
    },
    evidence_refs: [],
  });
};

const findPaymentLinks = async (context, route, actor, traceId) => {
  const url = new URL(context.request.url);
  const bookingId = clean(url.searchParams.get("booking_id"), 36);
  if (!isUuid(bookingId)) return problem(400, "validation_error", "A valid booking_id is required", traceId);
  const ledger = await loadLedger(context.env.APPLICATIONS_DB, bookingId);
  if (!ledger) return problem(404, "not_found", "Booking payment ledger not found", traceId);
  if (!canSee(route, actor, ledger.booking)) return problem(403, "forbidden", "Payment links are outside this actor's scope", traceId);
  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM simon_v3_resources
    WHERE kind = 'payment_link' AND owner_person_id = ?
      AND json_extract(data_json, '$.booking_id') = ?
    ORDER BY created_at DESC LIMIT 25
  `).bind(ledger.booking.owner_person_id, ledger.rootId).all();
  await auditRead(context, route, actor, traceId, ledger.rootId, "succeeded");
  return jsonResponse({ items: (result.results || []).map(resourceFromRow), next_cursor: null });
};

const getAssignmentReminderState = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const assignment = await loadResource(db, route.params.assignment_id);
  if (!assignment || assignment.kind !== "assignment") return problem(404, "not_found", "Assignment not found", traceId);
  if (!canSee(route, actor, assignment)) return problem(403, "forbidden", "The assignment is outside this actor's scope", traceId);
  const result = await db.prepare(`SELECT * FROM simon_v3_resources
    WHERE kind = 'notification' AND json_extract(data_json, '$.related_id') = ?
      AND json_extract(data_json, '$.template') = 'assignment_reminder'
    ORDER BY created_at DESC LIMIT 25`).bind(assignment.id).all();
  await auditRead(context, route, actor, traceId, assignment.id, "succeeded");
  return jsonResponse({ items: (result.results || []).map(resourceFromRow), next_cursor: null });
};

const getClientScopedView = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const client = await loadResource(db, route.params.client_id);
  if (!client || client.kind !== "client" || Number(client.archived)) return problem(404, "not_found", "Client not found", traceId);
  if (!canSee(route, actor, client)) return problem(403, "forbidden", "The client view is outside this actor's scope", traceId);
  const ownerPersonId = client.owner_person_id || client.id;
  const related = await db.prepare(`SELECT * FROM simon_v3_resources
    WHERE owner_person_id = ? AND kind IN ('application', 'booking', 'payment_link')
      AND archived = 0 ORDER BY updated_at DESC LIMIT 100`).bind(ownerPersonId).all();
  await auditRead(context, route, actor, traceId, client.id, "succeeded");
  return jsonResponse({
    id: client.id, kind: "client_view", version: Number(client.version),
    data: {
      client: resourceFromRow(client).data,
      applications: (related.results || []).filter((row) => row.kind === "application").map(resourceFromRow),
      bookings: (related.results || []).filter((row) => row.kind === "booking").map(resourceFromRow),
      payment_links: (related.results || []).filter((row) => row.kind === "payment_link").map(resourceFromRow),
    }, evidence_refs: [],
  });
};

const getEmployeeSessionView = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const employee = await loadResource(db, route.params.employee_id);
  if (!employee || employee.kind !== "employee" || employee.state === "inactive") return problem(404, "not_found", "Employee not found", traceId);
  if (!canSee(route, actor, employee)) return problem(403, "forbidden", "The employee view is outside this actor's scope", traceId);
  const booking = await loadResource(db, route.params.booking_id);
  if (!booking || booking.kind !== "booking" || booking.state === "cancelled") return problem(404, "not_found", "Booking not found", traceId);
  const assignmentResult = await db.prepare(`SELECT * FROM simon_v3_resources
    WHERE kind = 'assignment' AND owner_person_id = ?
      AND json_extract(data_json, '$.booking_id') = ?
      AND state IN ('pending', 'accepted') ORDER BY updated_at DESC LIMIT 1`)
    .bind(employee.id, booking.id).all();
  const assignment = (assignmentResult.results || [])[0];
  if (!assignment) return problem(403, "forbidden", "Employee is not assigned to that session", traceId);
  const data = JSON.parse(booking.data_json);
  await auditRead(context, route, actor, traceId, booking.id, "succeeded");
  return jsonResponse({
    id: booking.id, kind: "employee_session_view", version: Number(booking.version),
    data: {
      booking_id: booking.id, service_id: data.service_id, summary: data.summary,
      starts_at: data.starts_at, ends_at: data.ends_at,
      session_notes: data.session_notes || null, assignment_state: assignment.state,
    }, evidence_refs: [],
  });
};

const getFileMetadata = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const row = await loadResource(db, route.params.file_id);
  if (!row || row.kind !== "file" || Number(row.archived)) return problem(404, "not_found", "File metadata not found", traceId);
  if (!canSee(route, actor, row)) return problem(403, "forbidden", "The file is outside this actor's scope", traceId);
  const data = JSON.parse(row.data_json);
  if (!["admin", "system"].includes(actor.role)) delete data.private_storage_ref;
  await auditRead(context, route, actor, traceId, row.id, "succeeded");
  return jsonResponse({ id: row.id, kind: "file", version: Number(row.version), data, evidence_refs: [] });
};

const listFilesDueForRetention = async (context, route, actor, traceId) => {
  const before = clean(new URL(context.request.url).searchParams.get("before"), 40);
  const beforeTime = Date.parse(before);
  if (Number.isNaN(beforeTime) || beforeTime > Date.now() + 5 * 60 * 1000) {
    return problem(400, "validation_error", "A current or past retention cutoff is required", traceId);
  }
  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM simon_v3_resources
    WHERE kind = 'file' AND archived = 0 AND state IN ('ready', 'expiring')
      AND json_extract(data_json, '$.scan_state') = 'clean'
      AND json_extract(data_json, '$.retention_expires_at') <= ?
    ORDER BY json_extract(data_json, '$.retention_expires_at') ASC LIMIT 25
  `).bind(new Date(beforeTime).toISOString()).all();
  const items = (result.results || []).map((row) => {
    const data = JSON.parse(row.data_json);
    return {
      id: row.id, kind: "file", version: Number(row.version),
      data: {
        state: row.state, scan_state: data.scan_state, usable: data.usable,
        retention_policy: data.retention_policy,
        retention_expires_at: data.retention_expires_at,
      },
      evidence_refs: [],
    };
  });
  await auditRead(context, route, actor, traceId, null, "succeeded");
  return jsonResponse({ items, next_cursor: null });
};

const completePaymentOperation = async (db, {
  operationId, route, actor, traceId, refs, steps, after = null, statements = [], resourceId,
}) => {
  await db.batch([
    ...statements,
    db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
      steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
      .bind(JSON.stringify(refs), JSON.stringify(steps), after, now(), operationId),
    eventStatement(db, {
      traceId, route, actor, resourceId, operationId, outcome: "succeeded",
      evidence: { provider: route.provider || "website", provider_confirmed: true },
    }),
  ]);
  return jsonResponse(operationFromRow(
    await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(operationId).first(),
  ), 202);
};

const mutatePayment = async (
  context, route, actor, traceId, key, requestHash, body,
) => {
  const db = context.env.APPLICATIONS_DB;
  const operationId = crypto.randomUUID();
  if (route.operationId === "createPaymentLink") {
    if (!hasOnlyKeys(body.data, ["booking_id", "amount_minor", "purpose", "customer_email"])) {
      return problem(400, "validation_error", "Payment-link data contains unsupported fields", traceId);
    }
    const bookingId = clean(body.data.booking_id, 36);
    const ledger = isUuid(bookingId) ? await loadLedger(db, bookingId) : null;
    if (!ledger) return problem(404, "not_found", "Booking payment ledger not found", traceId);
    if (!canSee(route, actor, ledger.booking)) return problem(403, "forbidden", "The payment ledger is outside this actor's scope", traceId);
    const suppliedAmount = body.data.amount_minor === undefined ? null : Number(body.data.amount_minor);
    let amount = ledger.remaining;
    if (["admin", "system"].includes(actor.role)) {
      if (suppliedAmount !== null) amount = suppliedAmount;
    } else if (suppliedAmount !== null && suppliedAmount !== ledger.remaining) {
      return problem(403, "forbidden", "Partial payments require Admin approval", traceId);
    }
    if (!Number.isInteger(amount) || amount <= 0) return problem(409, "invalid_transition", "A zero or invalid payment link is forbidden", traceId);
    const reusable = await db.prepare(`
      SELECT * FROM simon_v3_resources
      WHERE kind = 'payment_link' AND owner_person_id = ?
        AND json_extract(data_json, '$.booking_id') = ?
        AND json_extract(data_json, '$.amount_minor') = ?
        AND state = 'unpaid' AND (json_extract(data_json, '$.expires_at') IS NULL
          OR json_extract(data_json, '$.expires_at') > ?)
      ORDER BY created_at DESC LIMIT 2
    `).bind(ledger.booking.owner_person_id, ledger.rootId, amount, now()).all();
    if ((reusable.results || []).length > 1) {
      return problem(409, "invalid_transition", "Multiple valid payment links require reconciliation", traceId);
    }
    if ((reusable.results || []).length === 1) {
      const existing = reusable.results[0];
      const existingData = JSON.parse(existing.data_json);
      let verified;
      try {
        verified = await getSimonCheckout(context.env, existingData.stripe_checkout_session_id);
      } catch {
        return problem(502, "provider_failure", "Stripe did not confirm the reusable payment link", traceId);
      }
      if (verified.payment_status !== "unpaid" || verified.status !== "open"
          || Number(verified.amount_total) !== amount
          || verified.metadata?.simon_v3_booking_id !== ledger.rootId
          || verified.metadata?.simon_v3_payment_link_id !== existing.id) {
        return problem(409, "invalid_transition", "Stored payment link must be reconciled before another link is created", traceId);
      }
      const refs = [{ kind: "payment_link", id: existing.id, version: Number(existing.version) }];
      await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
      return completePaymentOperation(db, {
        operationId, route, actor, traceId, refs, resourceId: existing.id,
        steps: [{ name: "reuse_valid_unpaid_link", status: "succeeded", provider_confirmed: true, provider_receipt_ref: verified.id, retry_safe: true, error: null }],
      });
    }
    const linkId = crypto.randomUUID();
    const refs = [{ kind: "payment_link", id: linkId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    try {
      const origin = new URL(context.request.url).origin;
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      const checkout = await createSimonPaymentCheckout(context.env, {
        idempotencyKey: key, paymentLinkId: linkId, bookingId: ledger.rootId, amountMinor: amount,
        customerEmail: clean(body.data.customer_email, 320) || null,
        description: clean(body.data.purpose, 120) || "Right Mind Creative session payment",
        successUrl: `${origin}/payment-result?state=success`,
        cancelUrl: `${origin}/payment-result?state=cancelled`, expiresAt: expiresAtEpoch,
      });
      if (!checkout.id || !checkout.url || checkout.payment_status !== "unpaid" || checkout.livemode !== false
          || Number(checkout.amount_total) !== amount
          || checkout.metadata?.simon_v3_booking_id !== ledger.rootId
          || checkout.metadata?.simon_v3_payment_link_id !== linkId) {
        throw new Error("Stripe returned an invalid test checkout receipt.");
      }
      const data = {
        id: linkId, booking_id: ledger.rootId, client_person_id: ledger.booking.owner_person_id,
        amount_minor: amount, currency: "USD", purpose: clean(body.data.purpose, 120) || "remaining_balance",
        state: "unpaid", stripe_checkout_session_id: checkout.id, checkout_url: checkout.url,
        expires_at: new Date(Number(checkout.expires_at || expiresAtEpoch) * 1000).toISOString(),
      };
      return completePaymentOperation(db, {
        operationId, route, actor, traceId, refs, resourceId: linkId,
        steps: [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: checkout.id, retry_safe: true, error: null }],
        after: JSON.stringify(data),
        statements: [db.prepare(`INSERT INTO simon_v3_resources
          (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
          VALUES (?, 'payment_link', 1, 'unpaid', ?, ?, 0, ?, ?)`)
          .bind(linkId, ledger.booking.owner_person_id, JSON.stringify(data), timestamp, timestamp)],
      });
    } catch (error) {
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: linkId });
      return problem(502, "provider_failure", "Stripe did not confirm the payment link", traceId, "No payment link was represented as successful.", { operation_id: operationId });
    }
  }
  if (route.operationId === "addLedgerEntry") {
    if (!hasOnlyKeys(body.data, ["id", "booking_id", "entry_kind", "amount_minor", "stripe_reference", "note", "currency"])) {
      return problem(400, "validation_error", "Ledger-entry data contains unsupported fields", traceId);
    }
    const ledger = isUuid(body.data.booking_id) ? await loadLedger(db, body.data.booking_id) : null;
    const entryKind = clean(body.data.entry_kind, 40);
    const amount = Number(body.data.amount_minor);
    const reference = clean(body.data.stripe_reference, 255) || null;
    if (!ledger) return problem(404, "not_found", "Booking payment ledger not found", traceId);
    if (!ledgerKinds.has(entryKind) || !Number.isInteger(amount) || amount <= 0 || (body.data.currency && body.data.currency !== "USD")) {
      return problem(400, "validation_error", "Ledger entries require a positive exact USD amount and supported kind", traceId);
    }
    const stripeKinds = new Set(["deposit_payment", "payment", "refund"]);
    if (stripeKinds.has(entryKind) && !reference) return problem(400, "validation_error", "Stripe-backed ledger entries require a provider reference", traceId);
    let receipt = operationId;
    try {
      if (["deposit_payment", "payment"].includes(entryKind)) {
        if (!reference.startsWith("cs_")) throw new Error("Payment receipt must be a Stripe Checkout session.");
        const checkout = await getSimonCheckout(context.env, reference);
        if (checkout.payment_status !== "paid" || Number(checkout.amount_total) !== amount
            || checkout.metadata?.simon_v3_booking_id !== ledger.rootId) throw new Error("Stripe payment receipt is not paid, exact, or linked to this booking.");
        receipt = checkout.id;
      } else if (entryKind === "refund") {
        if (!reference.startsWith("re_")) throw new Error("Refund receipt must be a Stripe refund.");
        const refund = await getSimonRefund(context.env, reference);
        if (refund.status !== "succeeded" || Number(refund.amount) !== amount) throw new Error("Stripe refund receipt is not succeeded or exact.");
        receipt = refund.id;
      }
    } catch (error) {
      return problem(502, "provider_failure", "Stripe did not confirm the ledger entry", traceId);
    }
    const entryId = body.data.id && isUuid(body.data.id) ? body.data.id : crypto.randomUUID();
    const refs = [{ kind: "ledger_entry", id: entryId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    const data = { id: entryId, booking_id: ledger.rootId, entry_kind: entryKind, amount_minor: amount, currency: "USD", stripe_reference: reference, note: clean(body.data.note, 500) || null };
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: entryId,
      steps: [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: receipt, retry_safe: true, error: null }],
      after: JSON.stringify(data),
      statements: [db.prepare(`INSERT INTO simon_v3_resources
        (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
        VALUES (?, 'ledger_entry', 1, 'posted', ?, ?, 0, ?, ?)`)
        .bind(entryId, ledger.booking.owner_person_id, JSON.stringify(data), timestamp, timestamp)],
    });
  }
  if (route.operationId === "createRefund") {
    if (!hasOnlyKeys(body.data, ["booking_id", "payment_intent_id", "amount_minor"])) {
      return problem(400, "validation_error", "Refund data contains unsupported fields", traceId);
    }
    const ledger = isUuid(body.data.booking_id) ? await loadLedger(db, body.data.booking_id) : null;
    const amount = Number(body.data.amount_minor);
    const paymentIntentId = clean(body.data.payment_intent_id, 255);
    if (!ledger) return problem(404, "not_found", "Booking payment ledger not found", traceId);
    if (!Number.isInteger(amount) || amount <= 0 || !paymentIntentId.startsWith("pi_")) return problem(400, "validation_error", "Refund requires an exact positive amount and Stripe payment intent", traceId);
    const refundId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const refs = [{ kind: "refund", id: refundId, version: 1 }, { kind: "ledger_entry", id: entryId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    try {
      const refund = await createSimonRefund(context.env, { idempotencyKey: key, bookingId: ledger.rootId, paymentIntentId, amountMinor: amount });
      if (!refund.id || refund.status !== "succeeded" || Number(refund.amount) !== amount
          || refund.livemode !== false || refund.payment_intent !== paymentIntentId
          || refund.metadata?.simon_v3_booking_id !== ledger.rootId) throw new Error("Stripe returned an invalid refund receipt.");
      const refundData = { id: refundId, booking_id: ledger.rootId, amount_minor: amount, currency: "USD", payment_intent_id: paymentIntentId, stripe_refund_id: refund.id, state: "succeeded" };
      const entryData = { id: entryId, booking_id: ledger.rootId, entry_kind: "refund", amount_minor: amount, currency: "USD", stripe_reference: refund.id };
      return completePaymentOperation(db, {
        operationId, route, actor, traceId, refs, resourceId: refundId,
        steps: [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: refund.id, retry_safe: true, error: null }],
        after: JSON.stringify(refundData),
        statements: [
          db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
            VALUES (?, 'refund', 1, 'succeeded', ?, ?, 0, ?, ?)`).bind(refundId, ledger.booking.owner_person_id, JSON.stringify(refundData), timestamp, timestamp),
          db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
            VALUES (?, 'ledger_entry', 1, 'posted', ?, ?, 0, ?, ?)`).bind(entryId, ledger.booking.owner_person_id, JSON.stringify(entryData), timestamp, timestamp),
        ],
      });
    } catch (error) {
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: refundId });
      return problem(502, "provider_failure", "Stripe did not confirm the refund", traceId, "No refund was represented as successful.", { operation_id: operationId });
    }
  }
  if (route.operationId === "reconcilePayment") {
    if (!hasOnlyKeys(body.data, ["payment_link_id"]) || !isUuid(body.data.payment_link_id)) return problem(400, "validation_error", "A valid payment_link_id is required", traceId);
    const link = await loadResource(db, body.data.payment_link_id);
    if (!link || link.kind !== "payment_link") return problem(404, "not_found", "Payment link not found", traceId);
    const linkData = JSON.parse(link.data_json);
    const refs = [{ kind: "payment_link", id: link.id, version: Number(link.version) + 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    try {
      const checkout = await getSimonCheckout(context.env, linkData.stripe_checkout_session_id);
      const state = checkout.payment_status === "paid" ? "paid" : checkout.status === "expired" ? "expired" : "unpaid";
      if (Number(checkout.amount_total) !== Number(linkData.amount_minor)
          || checkout.metadata?.simon_v3_booking_id !== linkData.booking_id
          || checkout.metadata?.simon_v3_payment_link_id !== link.id) throw new Error("Stripe receipt did not match the payment link.");
      const updated = { ...linkData, state, payment_intent_id: checkout.payment_intent || null, reconciled_at: now() };
      const statements = [db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, data_json = ?, updated_at = ? WHERE id = ?")
        .bind(Number(link.version) + 1, state, JSON.stringify(updated), timestamp, link.id)];
      if (state === "paid") {
        const existing = await db.prepare(`SELECT id FROM simon_v3_resources WHERE kind = 'ledger_entry'
          AND json_extract(data_json, '$.stripe_reference') = ? LIMIT 1`).bind(checkout.id).first();
        if (!existing) {
          const entryId = crypto.randomUUID();
          const entryData = { id: entryId, booking_id: linkData.booking_id, entry_kind: "payment", amount_minor: Number(linkData.amount_minor), currency: "USD", stripe_reference: checkout.id };
          refs.push({ kind: "ledger_entry", id: entryId, version: 1 });
          statements.push(db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
            VALUES (?, 'ledger_entry', 1, 'posted', ?, ?, 0, ?, ?)`).bind(entryId, link.owner_person_id, JSON.stringify(entryData), timestamp, timestamp));
        }
      }
      return completePaymentOperation(db, {
        operationId, route, actor, traceId, refs, resourceId: link.id, statements,
        steps: [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: checkout.id, retry_safe: true, error: null }],
        after: JSON.stringify(updated),
      });
    } catch (error) {
      await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: link.id });
      return problem(502, "provider_failure", "Stripe did not confirm payment status", traceId, "Stored payment state was preserved.", { operation_id: operationId });
    }
  }
  return failedProviderOperation(context, route, actor, traceId, key, requestHash);
};

const notificationWrite = (db, data, owner, timestamp) => db.prepare(`INSERT INTO simon_v3_resources
  (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
  VALUES (?, 'notification', 1, 'queued', ?, ?, 0, ?, ?)`)
  .bind(data.id, owner, JSON.stringify(data), timestamp, timestamp);

const mutateNotification = async (
  context, route, actor, traceId, key, requestHash, body,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!hasOnlyKeys(body.data, [
    "id", "recipient_person_id", "audience_role", "channel", "template", "dedupe_key",
    "related_kind", "related_id", "variables", "deliver_after",
  ])) return problem(400, "validation_error", "Notification data contains unsupported fields", traceId);
  const recipient = clean(body.data.recipient_person_id, 36) || null;
  const audienceRole = clean(body.data.audience_role, 20) || null;
  const channel = clean(body.data.channel, 20);
  const template = clean(body.data.template, 100);
  const dedupeKey = clean(body.data.dedupe_key, 200);
  const relatedId = clean(body.data.related_id, 36) || null;
  if ((!recipient && audienceRole !== "admin") || (recipient && !isUuid(recipient))
      || !["sms", "email"].includes(channel) || !template || dedupeKey.length < 8
      || (relatedId && !isUuid(relatedId))
      || (body.data.variables !== undefined && (typeof body.data.variables !== "object" || Array.isArray(body.data.variables)))) {
    return problem(400, "validation_error", "Notification requires a safe recipient, channel, template, and dedupe key", traceId);
  }
  const existing = await db.prepare(`SELECT * FROM simon_v3_resources
    WHERE kind = 'notification' AND json_extract(data_json, '$.dedupe_key') = ? LIMIT 1`)
    .bind(dedupeKey).first();
  const operationId = crypto.randomUUID();
  if (existing) {
    const refs = [{ kind: "notification", id: existing.id, version: Number(existing.version) }];
    await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: existing.id,
      steps: [{ name: "deduplicated_outbox_enqueue", status: "succeeded", provider_confirmed: true, provider_receipt_ref: existing.id, retry_safe: true, error: null }],
    });
  }
  const id = body.data.id && isUuid(body.data.id) ? body.data.id : crypto.randomUUID();
  const refs = [{ kind: "notification", id, version: 1 }];
  const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
  const data = {
    id, recipient_person_id: recipient, audience_role: audienceRole,
    channel, template, dedupe_key: dedupeKey,
    related_kind: clean(body.data.related_kind, 50) || null, related_id: relatedId,
    variables: body.data.variables || {}, deliver_after: body.data.deliver_after || null,
    state: "queued", attempts: 0, delivered_at: null, provider_receipt: null,
  };
  if (isStagingDeliveryProbe(data)) {
    await db.batch([
      notificationWrite(db, data, recipient, timestamp),
      eventStatement(db, {
        traceId, route, actor, resourceId: id, operationId, outcome: "queued",
        evidence: { provider: "gmail", provider_confirmed: false },
      }),
    ]);
    try {
      const receipt = await deliverStagingNotificationProbe(context.env, id);
      const delivered = {
        ...data,
        state: "delivered",
        attempts: 1,
        delivered_at: receipt.verified_at,
        provider_receipt: receipt.receipt_ref,
      };
      return completePaymentOperation(db, {
        operationId, route, actor, traceId,
        refs: [{ kind: "notification", id, version: 2 }],
        resourceId: id,
        steps: [
          {
            name: "durable_outbox_enqueue", status: "succeeded",
            provider_confirmed: true, provider_receipt_ref: id,
            retry_safe: true, error: null,
          },
          {
            name: "notification_delivery", status: "succeeded",
            provider_confirmed: true, provider_receipt_ref: receipt.receipt_ref,
            retry_safe: true, error: null,
          },
        ],
        after: JSON.stringify(delivered),
        statements: [
          db.prepare(`UPDATE simon_v3_resources SET version = ?, state = ?,
            data_json = ?, updated_at = ? WHERE id = ?`)
            .bind(2, "delivered", JSON.stringify(delivered), receipt.verified_at, id),
        ],
      });
    } catch {
      const failedAt = now();
      const failed = {
        ...data,
        state: "failed",
        attempts: 1,
        next_attempt_at: new Date(Date.parse(failedAt) + 60000).toISOString(),
        last_error_code: "delivery_provider_failure",
      };
      const steps = [
        {
          name: "durable_outbox_enqueue", status: "succeeded",
          provider_confirmed: true, provider_receipt_ref: id,
          retry_safe: true, error: null,
        },
        {
          name: "notification_delivery", status: "failed",
          provider_confirmed: false, provider_receipt_ref: null,
          retry_safe: true, error: { code: "provider_failure", provider: "gmail" },
        },
      ];
      await db.batch([
        db.prepare(`UPDATE simon_v3_resources SET version = ?, state = ?,
          data_json = ?, updated_at = ? WHERE id = ?`)
          .bind(2, "failed", JSON.stringify(failed), failedAt, id),
        db.prepare(`UPDATE simon_v3_operations SET status = 'partially_failed',
          resource_refs_json = ?, steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
          .bind(
            JSON.stringify([{ kind: "notification", id, version: 2 }]),
            JSON.stringify(steps), JSON.stringify(failed), failedAt, operationId,
          ),
        eventStatement(db, {
          traceId, route, actor, resourceId: id, operationId, outcome: "partially_failed",
          evidence: { provider: "gmail", provider_confirmed: false },
        }),
      ]);
      return problem(
        502, "provider_failure", "Staging notification delivery was not confirmed",
        traceId, "The notification remains retryable and no delivery was claimed.",
        { operation_id: operationId },
      );
    }
  }
  return completePaymentOperation(db, {
    operationId, route, actor, traceId, refs, resourceId: id,
    steps: [{ name: "durable_outbox_enqueue", status: "succeeded", provider_confirmed: true, provider_receipt_ref: id, retry_safe: true, error: null }],
    after: JSON.stringify(data), statements: [notificationWrite(db, data, recipient, timestamp)],
  });
};

const allowedFileTypes = new Set([
  "application/msword", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip",
  "audio/aac", "audio/aiff", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg",
  "audio/wav", "audio/x-aiff", "audio/x-m4a", "audio/x-wav",
  "image/gif", "image/jpeg", "image/png", "image/webp", "text/plain",
]);
const allowedFileExtensions = new Set([
  "aac", "aif", "aiff", "doc", "docx", "flac", "gif", "jpeg", "jpg", "m4a",
  "mp3", "mp4", "ogg", "pdf", "png", "txt", "wav", "wave", "webp", "zip",
]);

const decodeBase64 = (value) => {
  const source = String(value || "");
  if (!source || source.length > 36 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) return null;
  try {
    const binary = atob(source);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const sha256Hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const safeFileName = (value) => clean(value, 200).normalize("NFKD")
  .replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

const mutateFileIntake = async (
  context, route, actor, traceId, key, requestHash, body,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!context.env.APPLICATION_UPLOADS) return problem(503, "provider_failure", "Private staging storage is not configured", traceId);
  if (!hasOnlyKeys(body.data, [
    "id", "owner_person_id", "target_record_kind", "target_record_id", "filename",
    "declared_media_type", "content_base64", "checksum_sha256",
  ])) return problem(400, "validation_error", "File intake data contains unsupported fields", traceId);
  const id = body.data.id ? String(body.data.id) : crypto.randomUUID();
  const targetKind = clean(body.data.target_record_kind, 40);
  const targetId = clean(body.data.target_record_id, 36);
  const filename = safeFileName(body.data.filename);
  const mediaType = clean(body.data.declared_media_type, 160).toLowerCase();
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  const expectedHash = clean(body.data.checksum_sha256, 64).toLowerCase();
  const bytes = decodeBase64(body.data.content_base64);
  if (!isUuid(id) || !isUuid(targetId) || !["application", "booking", "client"].includes(targetKind)
      || !filename || !bytes || bytes.byteLength < 1 || bytes.byteLength > 25 * 1024 * 1024
      || !/^[0-9a-f]{64}$/.test(expectedHash)
      || !(allowedFileTypes.has(mediaType)
        || (mediaType === "application/octet-stream" && allowedFileExtensions.has(extension)))) {
    return problem(400, "validation_error", "File intake requires a supported non-empty file, exact checksum, and record scope", traceId);
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) return problem(400, "validation_error", "File checksum did not match the received bytes", traceId);
  const target = await loadResource(db, targetId);
  if (!target || target.kind !== targetKind || Number(target.archived)) return problem(404, "not_found", "Target record not found", traceId);
  if (actor.role === "client" && target.owner_person_id !== actor.person_id) return problem(403, "forbidden", "The target record is outside this client's scope", traceId);
  if (actor.role === "employee") {
    if (target.kind !== "booking") return problem(403, "forbidden", "Employees may attach files only to accepted sessions", traceId);
    const accepted = await db.prepare(`SELECT id FROM simon_v3_resources
      WHERE kind = 'assignment' AND owner_person_id = ?
        AND json_extract(data_json, '$.booking_id') = ? AND state = 'accepted' LIMIT 1`)
      .bind(actor.person_id, target.id).first();
    if (!accepted) return problem(403, "forbidden", "An accepted assignment is required", traceId);
  }
  const requestedOwner = clean(body.data.owner_person_id, 36);
  const owner = ["admin", "system"].includes(actor.role)
    ? (requestedOwner || target.owner_person_id || actor.person_id) : actor.person_id;
  if (!isUuid(owner)) return problem(400, "validation_error", "File owner must be a person UUID", traceId);
  const storageKey = `simon-v3/quarantine/${owner}/${id}/${filename}`;
  const operationId = crypto.randomUUID();
  const refs = [{ kind: "file", id, version: 1 }];
  const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
  try {
    await context.env.APPLICATION_UPLOADS.put(storageKey, bytes, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { simonV3FileId: id, targetKind, targetId, checksumSha256: actualHash },
    });
    const receipt = await context.env.APPLICATION_UPLOADS.head(storageKey);
    if (!receipt || Number(receipt.size) !== bytes.byteLength) throw new Error("Private storage receipt did not match received bytes.");
    const data = {
      id, owner_person_id: owner, target_record_kind: targetKind, target_record_id: targetId,
      filename, declared_media_type: mediaType, size_bytes: bytes.byteLength,
      checksum_sha256: actualHash, private_storage_ref: storageKey,
      scan_state: "pending", state: "quarantined", usable: false,
    };
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: id,
      steps: [{ name: "private_quarantine_receipt", status: "succeeded", provider_confirmed: true, provider_receipt_ref: clean(receipt.etag, 255) || id, retry_safe: true, error: null }],
      after: JSON.stringify(data), statements: [db.prepare(`INSERT INTO simon_v3_resources
        (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
        VALUES (?, 'file', 1, 'quarantined', ?, ?, 0, ?, ?)`)
        .bind(id, owner, JSON.stringify(data), timestamp, timestamp)],
    });
  } catch (error) {
    try { await context.env.APPLICATION_UPLOADS.delete(storageKey); } catch { /* deterministic private key */ }
    await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: id });
    return problem(502, "provider_failure", "Private storage did not confirm file quarantine", traceId, "The file was not accepted or marked clean.", { operation_id: operationId });
  }
};

const mutateFileScanResult = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  if (!hasOnlyKeys(body.data, [
    "scanner", "scanner_version", "signature_version", "checksum_sha256",
    "verdict", "scanned_at",
  ])) return problem(400, "validation_error", "File scan result contains unsupported fields", traceId);
  const scanner = clean(body.data.scanner, 40).toLowerCase();
  const scannerVersion = clean(body.data.scanner_version, 80);
  const signatureVersion = clean(body.data.signature_version, 120);
  const checksum = clean(body.data.checksum_sha256, 64).toLowerCase();
  const verdict = clean(body.data.verdict, 20).toLowerCase();
  const scannedAt = clean(body.data.scanned_at, 40);
  const scannedTime = Date.parse(scannedAt);
  const currentData = JSON.parse(current.data_json);
  if (scanner !== "clamav" || !scannerVersion || !signatureVersion
      || !/^[0-9a-f]{64}$/.test(checksum) || !["clean", "malicious"].includes(verdict)
      || Number.isNaN(scannedTime) || scannedTime > Date.now() + 5 * 60 * 1000) {
    return problem(400, "validation_error", "A complete ClamAV scan receipt is required", traceId);
  }
  if (checksum !== currentData.checksum_sha256) {
    return problem(409, "checksum_conflict", "Scan receipt checksum does not match the quarantined file", traceId);
  }
  if (currentData.scan_state !== "pending" || currentData.usable !== false) {
    return problem(409, "scan_state_conflict", "Only a pending quarantined file can accept its first scan receipt", traceId);
  }
  const timestamp = now();
  const operationId = crypto.randomUUID();
  const version = Number(current.version) + 1;
  const state = verdict === "clean" ? "ready" : "quarantined";
  const data = {
    ...currentData,
    scan_state: verdict,
    state,
    usable: verdict === "clean",
    scan_receipt: {
      provider: scanner,
      scanner_version: scannerVersion,
      signature_version: signatureVersion,
      checksum_sha256: checksum,
      scanned_at: new Date(scannedTime).toISOString(),
    },
  };
  if (verdict === "clean") {
    data.clean_promoted_at = new Date(scannedTime).toISOString();
    data.retention_policy = CLEAN_FILE_RETENTION_POLICY;
    data.retention_expires_at = addUtcCalendarMonths(scannedTime, 6);
  }
  const refs = [{ kind: "file", id: current.id, version }];
  await beginProviderOperation(context.env.APPLICATIONS_DB, {
    id: operationId, route, key, requestHash, traceId, actor,
    resourceRefs: refs, before: JSON.stringify(resourceFromRow(current)),
  });
  const receiptRef = `clamav:${checksum.slice(0, 16)}:${signatureVersion}`;
  const steps = [{
    name: "malware_scan", status: "succeeded", provider_confirmed: true,
    provider_receipt_ref: receiptRef, retry_safe: true, error: null,
  }];
  if (verdict === "malicious") {
    if (!context.env.APPLICATION_UPLOADS || !currentData.private_storage_ref) {
      await failProviderOperation(context.env.APPLICATIONS_DB, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(503, "provider_failure", "Private quarantine is not configured for malware removal", traceId);
    }
    try {
      await context.env.APPLICATION_UPLOADS.delete(currentData.private_storage_ref);
      if (await context.env.APPLICATION_UPLOADS.head(currentData.private_storage_ref)) {
        throw new Error("quarantine_purge_not_confirmed");
      }
      data.private_storage_ref = null;
      data.purged_at = timestamp;
      steps.push({
        name: "private_quarantine_purge", status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: current.id, retry_safe: true, error: null,
      });
    } catch {
      await failProviderOperation(context.env.APPLICATIONS_DB, {
        id: operationId, route, actor, traceId, resourceId: current.id,
      });
      return problem(
        502, "provider_failure", "Malicious quarantine removal was not confirmed",
        traceId, "The file remains unusable and quarantined.", { operation_id: operationId },
      );
    }
  }
  return completePaymentOperation(context.env.APPLICATIONS_DB, {
    operationId, route, actor, traceId, refs, resourceId: current.id,
    steps,
    after: JSON.stringify(data),
    statements: [context.env.APPLICATIONS_DB.prepare(`UPDATE simon_v3_resources SET version = ?,
      state = ?, data_json = ?, updated_at = ? WHERE id = ?`)
      .bind(version, state, JSON.stringify(data), timestamp, current.id)],
  });
};

const mutateFileRetentionExpiration = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  if (!hasOnlyKeys(body.data, [])) {
    return problem(400, "validation_error", "File expiration does not accept mutable fields", traceId);
  }
  const currentData = JSON.parse(current.data_json);
  const expiresAt = Date.parse(currentData.retention_expires_at || "");
  if (currentData.scan_state !== "clean"
      || !["ready", "expiring"].includes(current.state)
      || currentData.retention_policy !== CLEAN_FILE_RETENTION_POLICY
      || Number.isNaN(expiresAt)) {
    return problem(409, "retention_state_conflict", "Only a policy-bound clean file can expire", traceId);
  }
  if (expiresAt > Date.now()) {
    return problem(409, "retention_not_due", "The clean-file retention period has not ended", traceId);
  }
  if (!context.env.APPLICATION_UPLOADS || !currentData.private_storage_ref) {
    return problem(503, "provider_failure", "Private storage is not configured for retention expiration", traceId);
  }

  const timestamp = now();
  const startedReady = current.state === "ready";
  const expiringVersion = Number(current.version) + (startedReady ? 1 : 0);
  const finalVersion = expiringVersion + 1;
  const expiringData = {
    ...currentData,
    state: "expiring",
    usable: false,
    retention_expiration_started_at: currentData.retention_expiration_started_at || timestamp,
  };
  const operationId = crypto.randomUUID();
  const refs = [{ kind: "file", id: current.id, version: finalVersion }];
  await beginProviderOperation(context.env.APPLICATIONS_DB, {
    id: operationId, route, key, requestHash, traceId, actor,
    resourceRefs: refs, before: JSON.stringify(resourceFromRow(current)),
  });
  const steps = [];
  if (startedReady) {
    await context.env.APPLICATIONS_DB.prepare(`UPDATE simon_v3_resources SET version = ?,
      state = 'expiring', data_json = ?, updated_at = ? WHERE id = ?`)
      .bind(expiringVersion, JSON.stringify(expiringData), timestamp, current.id).run();
    steps.push({
      name: "retention_access_revoke", status: "succeeded", provider_confirmed: true,
      provider_receipt_ref: current.id, retry_safe: true, error: null,
    });
  }
  try {
    if (await context.env.APPLICATION_UPLOADS.head(currentData.private_storage_ref)) {
      await context.env.APPLICATION_UPLOADS.delete(currentData.private_storage_ref);
    }
    if (await context.env.APPLICATION_UPLOADS.head(currentData.private_storage_ref)) {
      throw new Error("retention_purge_not_confirmed");
    }
  } catch {
    await failProviderOperation(context.env.APPLICATIONS_DB, {
      id: operationId, route, actor, traceId, resourceId: current.id,
    });
    return problem(
      502, "provider_failure", "Private file retention removal was not confirmed",
      traceId, "The file is unavailable and will remain queued for safe retry.",
      { operation_id: operationId },
    );
  }
  const expiredData = {
    ...expiringData,
    state: "expired",
    private_storage_ref: null,
    expired_at: timestamp,
    retention_receipt: {
      policy: CLEAN_FILE_RETENTION_POLICY,
      bytes_deleted: true,
      checksum_sha256: currentData.checksum_sha256,
      deleted_at: timestamp,
    },
  };
  steps.push({
    name: "private_file_retention_purge", status: "succeeded", provider_confirmed: true,
    provider_receipt_ref: current.id, retry_safe: true, error: null,
  });
  return completePaymentOperation(context.env.APPLICATIONS_DB, {
    operationId, route, actor, traceId, refs, resourceId: current.id,
    steps, after: JSON.stringify(expiredData),
    statements: [context.env.APPLICATIONS_DB.prepare(`UPDATE simon_v3_resources SET version = ?,
      state = 'expired', data_json = ?, updated_at = ? WHERE id = ?`)
      .bind(finalVersion, JSON.stringify(expiredData), timestamp, current.id)],
  });
};

const mutateAssignment = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  const db = context.env.APPLICATIONS_DB;
  const operationId = crypto.randomUUID();
  if (route.operationId === "createAssignment") {
    if (!hasOnlyKeys(body.data, ["id", "booking_id", "employee_person_id", "notes", "reminder_at"])) {
      return problem(400, "validation_error", "Assignment data contains unsupported fields", traceId);
    }
    const bookingId = clean(body.data.booking_id, 36);
    const employeeId = clean(body.data.employee_person_id, 36);
    const booking = isUuid(bookingId) ? await loadResource(db, bookingId) : null;
    const employee = isUuid(employeeId) ? await loadResource(db, employeeId) : null;
    if (!booking || booking.kind !== "booking" || booking.state === "cancelled") return problem(404, "not_found", "Active booking not found", traceId);
    if (!employee || employee.kind !== "employee" || employee.state === "inactive") return problem(404, "not_found", "Active employee not found", traceId);
    const duplicate = await db.prepare(`SELECT * FROM simon_v3_resources
      WHERE kind = 'assignment' AND owner_person_id = ?
        AND json_extract(data_json, '$.booking_id') = ?
        AND state IN ('pending', 'accepted') LIMIT 1`).bind(employeeId, bookingId).first();
    if (duplicate) return problem(409, "invalid_transition", "An active assignment already exists", traceId);
    const id = body.data.id && isUuid(body.data.id) ? body.data.id : crypto.randomUUID();
    const notificationId = crypto.randomUUID();
    const refs = [{ kind: "assignment", id, version: 1 }, { kind: "notification", id: notificationId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    const data = { id, booking_id: bookingId, employee_person_id: employeeId, state: "pending", notes: clean(body.data.notes, 1000) || null, reminder_at: body.data.reminder_at || null };
    const notification = { id: notificationId, recipient_person_id: employeeId, audience_role: null, channel: "sms", template: "assignment_request", dedupe_key: `assignment-request:${id}:1`, related_kind: "assignment", related_id: id, variables: { booking_id: bookingId }, state: "queued", attempts: 0, delivered_at: null, provider_receipt: null };
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: id,
      steps: [
        { name: "assignment_created", status: "succeeded", provider_confirmed: true, provider_receipt_ref: id, retry_safe: true, error: null },
        { name: "notification_queued", status: "succeeded", provider_confirmed: true, provider_receipt_ref: notificationId, retry_safe: true, error: null },
      ],
      after: JSON.stringify(data),
      statements: [
        db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
          VALUES (?, 'assignment', 1, 'pending', ?, ?, 0, ?, ?)`).bind(id, employeeId, JSON.stringify(data), timestamp, timestamp),
        notificationWrite(db, notification, employeeId, timestamp),
      ],
    });
  }
  if (!current || current.kind !== "assignment") return problem(404, "not_found", "Assignment not found", traceId);
  const currentData = JSON.parse(current.data_json);
  let state;
  let template;
  let recipient = current.owner_person_id;
  if (route.operationId === "respondToAssignment") {
    if (!hasOnlyKeys(body.data, ["response"]) || !["accepted", "declined"].includes(body.data.response) || current.state !== "pending") {
      return problem(409, "invalid_transition", "Pending assignment requires an accepted or declined response", traceId);
    }
    state = body.data.response;
    template = "assignment_response_admin";
    recipient = null;
  } else if (route.operationId === "cancelAssignment") {
    if (!hasOnlyKeys(body.data, []) || !["pending", "accepted"].includes(current.state)) return problem(409, "invalid_transition", "Only an active assignment can be cancelled", traceId);
    state = "cancelled";
    template = "assignment_cancelled";
  } else {
    return failedProviderOperation(context, route, actor, traceId, key, requestHash);
  }
  const notificationId = crypto.randomUUID();
  const version = Number(current.version) + 1;
  const refs = [{ kind: "assignment", id: current.id, version }, { kind: "notification", id: notificationId, version: 1 }];
  const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
  const data = { ...currentData, state, responded_at: route.operationId === "respondToAssignment" ? timestamp : currentData.responded_at || null, cancelled_at: route.operationId === "cancelAssignment" ? timestamp : null };
  const notification = { id: notificationId, recipient_person_id: recipient, audience_role: recipient ? null : "admin", channel: "sms", template, dedupe_key: `${template}:${current.id}:${version}`, related_kind: "assignment", related_id: current.id, variables: { state }, state: "queued", attempts: 0, delivered_at: null, provider_receipt: null };
  return completePaymentOperation(db, {
    operationId, route, actor, traceId, refs, resourceId: current.id,
    steps: [
      { name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: current.id, retry_safe: true, error: null },
      { name: "notification_queued", status: "succeeded", provider_confirmed: true, provider_receipt_ref: notificationId, retry_safe: true, error: null },
    ],
    after: JSON.stringify(data),
    statements: [
      db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, data_json = ?, updated_at = ? WHERE id = ?").bind(version, state, JSON.stringify(data), timestamp, current.id),
      notificationWrite(db, notification, recipient, timestamp),
    ],
  });
};

const mutateApplicationLifecycle = async (
  context, route, actor, traceId, key, requestHash, body, current,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!current || current.kind !== "application") return problem(404, "not_found", "Application not found", traceId);
  const currentData = JSON.parse(current.data_json);
  const operationId = crypto.randomUUID();
  if (route.operationId === "submitApplication") {
    if (!hasOnlyKeys(body.data, []) || !["draft", "new"].includes(current.state)) return problem(409, "invalid_transition", "Only a draft application can be submitted", traceId);
    const version = Number(current.version) + 1;
    const notificationId = crypto.randomUUID();
    const refs = [{ kind: "application", id: current.id, version }, { kind: "notification", id: notificationId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    const data = { ...currentData, application_state: "awaiting_approval", submitted_at: timestamp };
    const notification = { id: notificationId, recipient_person_id: null, audience_role: "admin", channel: "sms", template: "application_submitted_admin", dedupe_key: `application-submitted:${current.id}:${version}`, related_kind: "application", related_id: current.id, variables: { application_id: current.id }, state: "queued", attempts: 0, delivered_at: null, provider_receipt: null };
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: current.id,
      steps: [{ name: "application_submitted", status: "succeeded", provider_confirmed: true, provider_receipt_ref: current.id, retry_safe: true, error: null }, { name: "admin_notification_queued", status: "succeeded", provider_confirmed: true, provider_receipt_ref: notificationId, retry_safe: true, error: null }],
      after: JSON.stringify(data), statements: [
        db.prepare("UPDATE simon_v3_resources SET version = ?, state = 'awaiting_approval', data_json = ?, updated_at = ? WHERE id = ?").bind(version, JSON.stringify(data), timestamp, current.id),
        notificationWrite(db, notification, null, timestamp),
      ],
    });
  }
  if (route.operationId === "declineApplication") {
    if (!hasOnlyKeys(body.data, ["note"]) || !["submitted", "awaiting_approval"].includes(current.state)) return problem(409, "invalid_transition", "Only an awaiting application can be declined", traceId);
    const version = Number(current.version) + 1;
    const notificationId = crypto.randomUUID();
    const refs = [{ kind: "application", id: current.id, version }, { kind: "notification", id: notificationId, version: 1 }];
    const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
    const data = { ...currentData, application_state: "declined", decision_note: clean(body.data.note, 1000) || null, decided_at: timestamp };
    const notification = { id: notificationId, recipient_person_id: current.owner_person_id, audience_role: null, channel: "sms", template: "application_declined", dedupe_key: `application-declined:${current.id}:${version}`, related_kind: "application", related_id: current.id, variables: { application_id: current.id }, state: "queued", attempts: 0, delivered_at: null, provider_receipt: null };
    return completePaymentOperation(db, {
      operationId, route, actor, traceId, refs, resourceId: current.id,
      steps: [{ name: "application_declined", status: "succeeded", provider_confirmed: true, provider_receipt_ref: current.id, retry_safe: true, error: null }, { name: "client_notification_queued", status: "succeeded", provider_confirmed: true, provider_receipt_ref: notificationId, retry_safe: true, error: null }],
      after: JSON.stringify(data), statements: [
        db.prepare("UPDATE simon_v3_resources SET version = ?, state = 'declined', data_json = ?, updated_at = ? WHERE id = ?").bind(version, JSON.stringify(data), timestamp, current.id),
        notificationWrite(db, notification, current.owner_person_id, timestamp),
      ],
    });
  }
  if (!["approveApplicationWithDeposit", "approveApplicationWithWaiver"].includes(route.operationId)) {
    return failedProviderOperation(context, route, actor, traceId, key, requestHash);
  }
  if (!["submitted", "awaiting_approval"].includes(current.state)) return problem(409, "invalid_transition", "Only an awaiting application can be approved", traceId);
  const depositRequired = route.operationId === "approveApplicationWithDeposit";
  const allowed = ["booking_id", "summary", "service_id", "starts_at", "ends_at", "agreed_total_minor", "currency", "customer_email"];
  if (depositRequired) allowed.push("deposit_amount_minor");
  if (!hasOnlyKeys(body.data, allowed)) return problem(400, "validation_error", "Application approval data contains unsupported fields", traceId);
  const bookingInputResult = bookingInput({
    id: body.data.booking_id, owner_person_id: current.owner_person_id,
    application_id: current.id, summary: body.data.summary, service_id: body.data.service_id,
    starts_at: body.data.starts_at, ends_at: body.data.ends_at,
    payment_state: depositRequired ? "deposit_pending" : "deposit_waived",
    agreed_total_minor: body.data.agreed_total_minor, currency: body.data.currency,
  });
  if (bookingInputResult.error) return problem(400, "validation_error", bookingInputResult.error, traceId);
  const depositAmount = Number(body.data.deposit_amount_minor);
  if (depositRequired && (!Number.isInteger(depositAmount) || depositAmount <= 0 || depositAmount > bookingInputResult.total)) {
    return problem(400, "validation_error", "Deposit approval requires an exact positive amount no greater than the agreed total", traceId);
  }
  if (!calendarIsConfigured(context.env)) return problem(503, "provider_failure", "Staging calendar is not configured", traceId);
  const busy = await getBusyPeriods(context.env, bookingInputResult.startsAt.toISOString(), bookingInputResult.endsAt.toISOString());
  if (busy.some((period) => bookingInputResult.startsAt < new Date(period.end) && bookingInputResult.endsAt > new Date(period.start))) return problem(409, "invalid_transition", "The complete approved booking duration is unavailable", traceId);
  if (await loadResource(db, bookingInputResult.id)) return problem(409, "invalid_transition", "Booking identifier already exists", traceId);
  const providerEventId = `simon${(await hashJson({ idempotency_key: key, provider: "calendar" })).slice(0, 48)}`;
  const linkId = depositRequired ? crypto.randomUUID() : null;
  const notificationId = crypto.randomUUID();
  const appVersion = Number(current.version) + 1;
  const refs = [{ kind: "application", id: current.id, version: appVersion }, { kind: "booking", id: bookingInputResult.id, version: 1 }, ...(linkId ? [{ kind: "payment_link", id: linkId, version: 1 }] : []), { kind: "notification", id: notificationId, version: 1 }];
  const timestamp = await beginProviderOperation(db, { id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs });
  let checkout = null;
  try {
    const event = await createCalendarEvent(context.env, {
      id: providerEventId, summary: bookingInputResult.summary,
      start: { dateTime: bookingInputResult.startsAt.toISOString(), timeZone: "America/Chicago" },
      end: { dateTime: bookingInputResult.endsAt.toISOString(), timeZone: "America/Chicago" }, transparency: "opaque",
      extendedProperties: { private: { simonV3ResourceId: bookingInputResult.id, applicationId: current.id, requestHash } },
    });
    if (!event?.id || event.id !== providerEventId || event.status === "cancelled") throw new Error("Invalid approval calendar receipt.");
    if (depositRequired) {
      const origin = new URL(context.request.url).origin;
      const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      checkout = await createSimonPaymentCheckout(context.env, {
        idempotencyKey: `${key}-deposit`, paymentLinkId: linkId, bookingId: bookingInputResult.id,
        amountMinor: depositAmount, customerEmail: clean(body.data.customer_email, 320) || null,
        description: `Right Mind Creative · ${bookingInputResult.serviceId} deposit`,
        successUrl: `${origin}/payment-result?state=success`, cancelUrl: `${origin}/payment-result?state=cancelled`, expiresAt,
      });
      if (!checkout.id || !checkout.url || checkout.payment_status !== "unpaid" || checkout.livemode !== false
          || Number(checkout.amount_total) !== depositAmount
          || checkout.metadata?.simon_v3_booking_id !== bookingInputResult.id
          || checkout.metadata?.simon_v3_payment_link_id !== linkId) throw new Error("Invalid approval Stripe receipt.");
    }
    const bookingData = { id: bookingInputResult.id, owner_person_id: current.owner_person_id, application_id: current.id, summary: bookingInputResult.summary, service_id: bookingInputResult.serviceId, starts_at: bookingInputResult.startsAt.toISOString(), ends_at: bookingInputResult.endsAt.toISOString(), payment_state: bookingInputResult.paymentState, booking_state: bookingInputResult.bookingState, agreed_total_minor: bookingInputResult.total, currency: "USD", provider_event_id: event.id };
    const appData = { ...currentData, application_state: "approved", booking_id: bookingInputResult.id, approved_at: timestamp, deposit_waived: !depositRequired };
    const notification = { id: notificationId, recipient_person_id: current.owner_person_id, audience_role: null, channel: "sms", template: depositRequired ? "application_approved_payment_link" : "application_approved_waiver", dedupe_key: `application-approved:${current.id}:${appVersion}`, related_kind: "application", related_id: current.id, variables: { application_id: current.id, booking_id: bookingInputResult.id, payment_link_id: linkId }, state: "queued", attempts: 0, delivered_at: null, provider_receipt: null };
    const statements = [
      db.prepare("UPDATE simon_v3_resources SET version = ?, state = 'approved', data_json = ?, updated_at = ? WHERE id = ?").bind(appVersion, JSON.stringify(appData), timestamp, current.id),
      db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
        VALUES (?, 'booking', 1, ?, ?, ?, 0, ?, ?)`).bind(bookingInputResult.id, bookingInputResult.bookingState, current.owner_person_id, JSON.stringify(bookingData), timestamp, timestamp),
      notificationWrite(db, notification, current.owner_person_id, timestamp),
    ];
    const steps = [{ name: "calendar_booking_created", status: "succeeded", provider_confirmed: true, provider_receipt_ref: event.id, retry_safe: true, error: null }];
    if (checkout) {
      const linkData = { id: linkId, booking_id: bookingInputResult.id, client_person_id: current.owner_person_id, amount_minor: depositAmount, currency: "USD", purpose: "deposit", state: "unpaid", stripe_checkout_session_id: checkout.id, checkout_url: checkout.url, expires_at: new Date(Number(checkout.expires_at) * 1000).toISOString() };
      statements.push(db.prepare(`INSERT INTO simon_v3_resources (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
        VALUES (?, 'payment_link', 1, 'unpaid', ?, ?, 0, ?, ?)`).bind(linkId, current.owner_person_id, JSON.stringify(linkData), timestamp, timestamp));
      steps.push({ name: "deposit_link_created", status: "succeeded", provider_confirmed: true, provider_receipt_ref: checkout.id, retry_safe: true, error: null });
    }
    steps.push({ name: "client_notification_queued", status: "succeeded", provider_confirmed: true, provider_receipt_ref: notificationId, retry_safe: true, error: null });
    return completePaymentOperation(db, { operationId, route, actor, traceId, refs, steps, resourceId: current.id, statements, after: JSON.stringify(appData) });
  } catch (error) {
    try { await deleteCalendarEvent(context.env, providerEventId); } catch { /* deterministic reconciliation ID */ }
    if (checkout?.id) {
      try { await expireSimonCheckout(context.env, checkout.id, `${key}-compensate`); } catch { /* failed operation requires reconciliation */ }
    }
    await failProviderOperation(db, { id: operationId, route, actor, traceId, resourceId: current.id });
    return problem(502, "provider_failure", "Providers did not confirm the complete application approval", traceId, "The approval was compensated where possible and requires reconciliation before retry.", { operation_id: operationId });
  }
};

const CLIENT_MERGE_MANAGED_FIELDS = new Set([
  "id", "owner_person_id", "version", "state", "archived", "merged_at",
  "merged_into_client_id", "merged_source_client_ids",
]);

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const mergeArtistIdentities = (sourceData, targetData) => {
  const values = [];
  for (const data of [targetData, sourceData]) {
    if (typeof data.artist_name === "string" && data.artist_name.trim()) values.push(data.artist_name.trim());
    if (Array.isArray(data.artist_identities)) {
      for (const value of data.artist_identities) {
        if (typeof value === "string" && value.trim()) values.push(value.trim());
      }
    }
  }
  return [...new Set(values)];
};

const resolveMergedClientData = (sourceData, targetData, resolutions) => {
  const result = { ...targetData };
  const conflicts = [];
  const keys = new Set([...Object.keys(sourceData), ...Object.keys(targetData)]);
  keys.delete("artist_identities");
  for (const key of keys) {
    if (CLIENT_MERGE_MANAGED_FIELDS.has(key)) continue;
    const sourceHas = Object.hasOwn(sourceData, key);
    const targetHas = Object.hasOwn(targetData, key);
    if (!targetHas && sourceHas) {
      result[key] = sourceData[key];
    } else if (sourceHas && targetHas && !jsonEqual(sourceData[key], targetData[key])) {
      const choice = resolutions[key];
      if (!['source', 'target'].includes(choice)) conflicts.push(key);
      else result[key] = choice === "source" ? sourceData[key] : targetData[key];
    }
  }
  const validResolutionKeys = new Set(conflicts);
  for (const key of keys) {
    if (sourceData[key] !== undefined && targetData[key] !== undefined
        && !jsonEqual(sourceData[key], targetData[key])) validResolutionKeys.add(key);
  }
  const unexpected = Object.keys(resolutions).filter((key) => (
    CLIENT_MERGE_MANAGED_FIELDS.has(key) || !validResolutionKeys.has(key)
  ));
  if (unexpected.length) return { error: "field_resolution_not_conflicting" };
  if (conflicts.length) return { error: "field_resolution_required", conflicts: conflicts.sort() };
  const artistIdentities = mergeArtistIdentities(sourceData, targetData);
  if (artistIdentities.length) result.artist_identities = artistIdentities;
  return { data: result };
};

const replaceMergedClientReferences = (
  value, { sourceOwnerId, targetOwnerId, sourceClientId, targetClientId }, parent = null,
) => {
  if (Array.isArray(value)) {
    return value.map((item) => replaceMergedClientReferences(
      item, { sourceOwnerId, targetOwnerId, sourceClientId, targetClientId }, parent,
    ));
  }
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["owner_person_id", "client_person_id", "recipient_person_id"].includes(key)
        && item === sourceOwnerId) result[key] = targetOwnerId;
    else if (["client_id", "owner_client_id"].includes(key) && item === sourceClientId) {
      result[key] = targetClientId;
    } else if (key === "target_record_id" && item === sourceClientId
        && value.target_record_kind === "client") result[key] = targetClientId;
    else result[key] = replaceMergedClientReferences(
      item, { sourceOwnerId, targetOwnerId, sourceClientId, targetClientId }, key,
    );
  }
  return result;
};

const mergeSnapshot = (row) => ({
  id: row.id, kind: row.kind, version: Number(row.version), state: row.state,
  owner_person_id: row.owner_person_id, data_json: row.data_json,
  archived: Number(row.archived), created_at: row.created_at, updated_at: row.updated_at,
});

const mutateClientMerge = async (
  context, route, actor, traceId, key, requestHash, body,
) => {
  const db = context.env.APPLICATIONS_DB;
  if (!hasOnlyKeys(body.data, [
    "source_client_id", "target_client_id", "source_version", "target_version",
    "field_resolutions",
  ])) return problem(400, "validation_error", "Client merge contains unsupported fields", traceId);
  const sourceId = clean(body.data.source_client_id, 36);
  const targetId = clean(body.data.target_client_id, 36);
  const sourceVersion = body.data.source_version;
  const targetVersion = body.data.target_version;
  const resolutions = body.data.field_resolutions;
  if (!isUuid(sourceId) || !isUuid(targetId) || sourceId === targetId
      || !Number.isInteger(sourceVersion) || sourceVersion < 1
      || !Number.isInteger(targetVersion) || targetVersion < 1
      || !resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)
      || Object.values(resolutions).some((value) => !["source", "target"].includes(value))) {
    return problem(400, "validation_error", "Merge requires distinct clients, exact versions, and explicit field choices", traceId);
  }
  const [source, target] = await Promise.all([loadResource(db, sourceId), loadResource(db, targetId)]);
  if (!source || source.kind !== "client" || Number(source.archived)
      || !target || target.kind !== "client" || Number(target.archived)) {
    return problem(404, "not_found", "Both active client records are required", traceId);
  }
  if (Number(source.version) !== sourceVersion || Number(target.version) !== targetVersion) {
    return problem(409, "version_conflict", "A selected client changed before merge", traceId, "No state was changed.");
  }
  const sourceData = JSON.parse(source.data_json);
  const targetData = JSON.parse(target.data_json);
  const resolution = resolveMergedClientData(sourceData, targetData, resolutions);
  if (resolution.error) {
    return problem(
      409, resolution.error, "Every conflicting client field requires an explicit choice",
      traceId, "No state was changed.", { conflicting_fields: resolution.conflicts || [] },
    );
  }
  const sourceOwnerId = source.owner_person_id || source.id;
  const targetOwnerId = target.owner_person_id || target.id;
  if (!isUuid(sourceOwnerId) || !isUuid(targetOwnerId)) {
    return problem(409, "identity_conflict", "Both clients require verified owner identities", traceId);
  }
  const relatedResult = await db.prepare(`SELECT * FROM simon_v3_resources
    WHERE owner_person_id = ? AND id NOT IN (?, ?) ORDER BY created_at ASC`)
    .bind(sourceOwnerId, sourceId, targetId).all();
  const related = relatedResult.results || [];
  const timestamp = now();
  const targetMergedIds = Array.isArray(targetData.merged_source_client_ids)
    ? targetData.merged_source_client_ids.filter((value) => isUuid(value)) : [];
  const mergedTargetData = {
    ...resolution.data,
    id: target.id,
    owner_person_id: targetOwnerId,
    merged_source_client_ids: [...new Set([...targetMergedIds, source.id])],
    merged_at: timestamp,
  };
  const mergedSourceData = {
    ...sourceData,
    id: source.id,
    owner_person_id: sourceOwnerId,
    merged_into_client_id: target.id,
    merged_at: timestamp,
  };
  const referenceContext = { sourceOwnerId, targetOwnerId, sourceClientId: source.id, targetClientId: target.id };
  const rewritten = related.map((row) => ({
    row,
    version: Number(row.version) + 1,
    data: replaceMergedClientReferences(JSON.parse(row.data_json), referenceContext),
  }));
  const snapshots = [source, target, ...related].map(mergeSnapshot);
  const refs = [
    { kind: "client", id: source.id, version: Number(source.version) + 1 },
    { kind: "client", id: target.id, version: Number(target.version) + 1 },
    ...rewritten.map(({ row, version }) => ({ kind: row.kind, id: row.id, version })),
  ];
  const operationId = crypto.randomUUID();
  await beginProviderOperation(db, {
    id: operationId, route, key, requestHash, traceId, actor, resourceRefs: refs,
    before: JSON.stringify({ type: "client_merge_v1", rows: snapshots }),
  });
  const steps = [
    { name: "resolve_client_field_conflicts", status: "succeeded", provider_confirmed: true, provider_receipt_ref: target.id, retry_safe: true, error: null },
    { name: "reassign_client_owned_records", status: "succeeded", provider_confirmed: true, provider_receipt_ref: String(rewritten.length), retry_safe: true, error: null },
    { name: "archive_merged_source_client", status: "succeeded", provider_confirmed: true, provider_receipt_ref: source.id, retry_safe: true, error: null },
  ];
  const rollbackDefinition = {
    available: true, type: "client_merge_v1", source_client_id: source.id,
    target_client_id: target.id, record_count: snapshots.length,
  };
  const statements = [
    db.prepare(`UPDATE simon_v3_resources SET version = ?, state = ?, owner_person_id = ?,
      data_json = ?, archived = 0, updated_at = ? WHERE id = ?`)
      .bind(Number(target.version) + 1, target.state, targetOwnerId, JSON.stringify(mergedTargetData), timestamp, target.id),
    db.prepare(`UPDATE simon_v3_resources SET version = ?, state = 'archived', owner_person_id = ?,
      data_json = ?, archived = 1, updated_at = ? WHERE id = ?`)
      .bind(Number(source.version) + 1, targetOwnerId, JSON.stringify(mergedSourceData), timestamp, source.id),
    ...rewritten.map(({ row, version, data }) => db.prepare(`UPDATE simon_v3_resources
      SET version = ?, owner_person_id = ?, data_json = ?, updated_at = ? WHERE id = ?`)
      .bind(version, targetOwnerId, JSON.stringify(data), timestamp, row.id)),
    db.prepare(`UPDATE simon_v3_operations SET status = 'succeeded', resource_refs_json = ?,
      steps_json = ?, rollback_json = ?, after_json = ?, completed_at = ? WHERE id = ?`)
      .bind(JSON.stringify(refs), JSON.stringify(steps), JSON.stringify(rollbackDefinition),
        JSON.stringify({ source_client_id: source.id, target_client_id: target.id, reassigned_records: rewritten.length }),
        timestamp, operationId),
    eventStatement(db, {
      traceId, route, actor, resourceId: target.id, operationId, outcome: "succeeded",
      evidence: { provider: "website", provider_confirmed: true, reassigned_records: rewritten.length },
    }),
  ];
  await db.batch(statements);
  const operation = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?")
    .bind(operationId).first();
  return jsonResponse(operationFromRow(operation), 202);
};

const rollback = async (context, route, actor, traceId, key, requestHash) => {
  const db = context.env.APPLICATIONS_DB;
  const source = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(route.params.operation_id).first();
  if (!source) return problem(404, "not_found", "Operation not found", traceId);
  const definition = JSON.parse(source.rollback_json || '{"available":false}');
  if (!definition.available) return problem(409, "invalid_transition", "That operation cannot be rolled back", traceId);
  if (definition.type === "client_merge_v1") {
    const beforeBundle = JSON.parse(source.before_json || "{}");
    const refs = JSON.parse(source.resource_refs_json || "[]");
    if (beforeBundle.type !== "client_merge_v1" || !Array.isArray(beforeBundle.rows)
        || beforeBundle.rows.length !== refs.length) {
      return problem(409, "invalid_transition", "Client merge rollback evidence is incomplete", traceId);
    }
    const currentRows = [];
    for (const ref of refs) {
      const current = await loadResource(db, ref.id);
      if (!current || current.kind !== ref.kind || Number(current.version) !== Number(ref.version)) {
        return problem(409, "version_conflict", "A merged record changed after the merge", traceId, "No state was changed.");
      }
      currentRows.push(current);
    }
    const timestamp = now();
    const operationId = crypto.randomUUID();
    const restoredRefs = currentRows.map((row) => ({
      kind: row.kind, id: row.id, version: Number(row.version) + 1,
    }));
    const steps = [{
      name: "restore_client_merge_before_images", status: "compensated",
      provider_confirmed: true, provider_receipt_ref: operationId, retry_safe: true, error: null,
    }];
    const operation = {
      id: operationId, status: "rolled_back", idempotency_key: key, trace_id: traceId,
      resource_refs: restoredRefs, steps, rollback: { available: false },
      created_at: timestamp, completed_at: timestamp,
    };
    const statements = beforeBundle.rows.map((before, index) => db.prepare(`UPDATE simon_v3_resources
      SET version = ?, state = ?, owner_person_id = ?, data_json = ?, archived = ?, updated_at = ?
      WHERE id = ?`).bind(
      restoredRefs[index].version, before.state, before.owner_person_id, before.data_json,
      before.archived, timestamp, before.id,
    ));
    statements.push(
      db.prepare(`INSERT INTO simon_v3_operations
        (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role,
         status, resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'rolled_back', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(operationId, route.operationId, key, requestHash, traceId, actor.person_id, actor.role,
          JSON.stringify(restoredRefs), JSON.stringify(steps), '{"available":false}',
          source.after_json, source.before_json, timestamp, timestamp),
      eventStatement(db, {
        traceId, route, actor, resourceId: definition.target_client_id,
        operationId, outcome: "rolled_back", evidence: { source_operation_id: source.id },
      }),
    );
    await db.batch(statements);
    return jsonResponse(operation, 202);
  }
  const refs = JSON.parse(source.resource_refs_json || "[]");
  const target = refs[0];
  if (!target || !source.before_json) return problem(409, "invalid_transition", "Rollback evidence is incomplete", traceId);
  const current = await loadResource(db, target.id);
  if (!current || current.kind !== target.kind || Number(current.version) !== Number(target.version)) {
    return problem(409, "version_conflict", "Rollback target changed after the source operation", traceId, "No state was changed.");
  }
  const before = JSON.parse(source.before_json);
  const timestamp = now();
  const operationId = crypto.randomUUID();
  const version = Number(current.version) + 1;
  const operation = {
    id: operationId, status: "rolled_back", idempotency_key: key, trace_id: traceId,
    resource_refs: [{ kind: target.kind, id: target.id, version }],
    steps: [{ name: "restore_before_image", status: "compensated", provider_confirmed: true, provider_receipt_ref: operationId, retry_safe: true, error: null }],
    rollback: { available: false }, created_at: timestamp, completed_at: timestamp,
  };
  await db.batch([
    db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, owner_person_id = ?, data_json = ?, archived = ?, updated_at = ? WHERE id = ?")
      .bind(version, before.state, before.owner_person_id, before.data_json, before.archived, timestamp, target.id),
    db.prepare(`INSERT INTO simon_v3_operations
      (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role, status,
       resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'rolled_back', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, route.operationId, key, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(operation.resource_refs), JSON.stringify(operation.steps), JSON.stringify(operation.rollback), source.after_json, source.before_json, timestamp, timestamp),
    eventStatement(db, { traceId, route, actor, resourceId: target.id, operationId, outcome: "rolled_back", evidence: { source_operation_id: source.id } }),
  ]);
  return jsonResponse(operation, 202);
};

const mutate = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const rawIdempotencyKey = String(context.request.headers.get("idempotency-key") || "").trim();
  if (rawIdempotencyKey.length < 16 || rawIdempotencyKey.length > 200) {
    return problem(400, "validation_error", "Idempotency-Key must be between 16 and 200 characters", traceId);
  }
  const idempotencyKey = rawIdempotencyKey;
  if (!isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
  const parsed = await readJson(context.request, traceId);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  const bodyShapeIsValid = hasOnlyKeys(body, ["actor", "reason", "authorization_digest", "override", "data"])
    && hasOnlyKeys(body?.actor, ["person_id", "role", "authority_grant_id"]);
  if (!bodyShapeIsValid || !actorMatches(actor, body?.actor) || !clean(body?.reason) || !body?.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return problem(400, "validation_error", "Mutation actor, reason, and data are required and must match the authenticated actor", traceId);
  }
  const requestHash = await hashJson({ operationId: route.operationId, params: route.params, body });
  const duplicate = await existingOperation(db, idempotencyKey, requestHash, traceId);
  if (duplicate?.error) return duplicate.error;
  if (duplicate?.response) return duplicate.response;
  if (route.special === "rollback") return rollback(context, route, actor, traceId, idempotencyKey, requestHash);

  const targetId = routeId(route);
  const current = targetId ? await loadResource(db, targetId) : null;
  if (targetId && (!current || current.kind !== route.kind)) return problem(404, "not_found", "Resource not found", traceId);
  if (current && !canSee(route, actor, current)) return problem(403, "forbidden", "The resource is outside this actor's scope", traceId);
  if (route.ifMatch) {
    const supplied = parseVersion(context.request.headers.get("if-match"));
    if (!supplied || supplied !== Number(current?.version)) return problem(409, "version_conflict", "If-Match does not match the current resource version", traceId);
  }
  if (["createCalendarHold", "updateCalendarHold", "cancelCalendarHold"].includes(route.operationId)) {
    return mutateCalendarHold(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (["createBooking", "updateBooking", "rescheduleBooking", "splitBooking", "cancelBooking", "restoreBooking"].includes(route.operationId)) {
    return mutateBooking(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (["createPaymentLink", "addLedgerEntry", "createRefund", "reconcilePayment"].includes(route.operationId)) {
    return mutatePayment(
      context, route, actor, traceId, idempotencyKey, requestHash, body,
    );
  }
  if (route.operationId === "enqueueNotification") {
    return mutateNotification(
      context, route, actor, traceId, idempotencyKey, requestHash, body,
    );
  }
  if (route.operationId === "createFileIntake") {
    return mutateFileIntake(
      context, route, actor, traceId, idempotencyKey, requestHash, body,
    );
  }
  if (route.operationId === "mergeClients") {
    return mutateClientMerge(
      context, route, actor, traceId, idempotencyKey, requestHash, body,
    );
  }
  if (route.operationId === "recordFileScanResult") {
    return mutateFileScanResult(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (route.operationId === "expireFileForRetention") {
    return mutateFileRetentionExpiration(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (["createAssignment", "respondToAssignment", "cancelAssignment"].includes(route.operationId)) {
    return mutateAssignment(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (["submitApplication", "approveApplicationWithDeposit", "approveApplicationWithWaiver", "declineApplication"].includes(route.operationId)) {
    return mutateApplicationLifecycle(
      context, route, actor, traceId, idempotencyKey, requestHash, body, current,
    );
  }
  if (route.provider) return failedProviderOperation(context, route, actor, traceId, idempotencyKey, requestHash);

  if (["kind", "version", "state", "archived"].some((field) => body.data[field] !== undefined)) {
    return problem(400, "validation_error", "System-managed resource fields cannot be changed directly", traceId);
  }

  const id = targetId || (isUuid(body.data.id) ? body.data.id : crypto.randomUUID());
  const timestamp = now();
  const version = current ? Number(current.version) + 1 : 1;
  const data = { ...(current ? JSON.parse(current.data_json) : {}), ...body.data, id };
  const requestedOwner = clean(body.data.owner_person_id, 36);
  const owner = ["admin", "system"].includes(actor.role)
    ? (requestedOwner || current?.owner_person_id || null)
    : (current?.owner_person_id || actor.person_id);
  if (route.ownerScoped || body.data.owner_person_id !== undefined) data.owner_person_id = owner;
  const state = stateFor(route.operationId, data, current?.state);
  const archived = route.operationId === "archiveClient" ? 1 : route.operationId === "restoreClient" ? 0 : Number(current?.archived || 0);
  const operationId = crypto.randomUUID();
  const resourceRefs = [{ kind: route.kind, id, version }];
  const steps = [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: operationId, retry_safe: true, error: null }];
  const rollbackInfo = { available: Boolean(current), kind: current ? "before_image" : null, constraints: current ? ["resource version must remain unchanged"] : [] };
  const operation = { id: operationId, status: "succeeded", idempotency_key: idempotencyKey, trace_id: traceId, resource_refs: resourceRefs, steps, rollback: rollbackInfo, created_at: timestamp, completed_at: timestamp };
  const before = current ? JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: current.data_json, archived: current.archived }) : null;
  const after = JSON.stringify({ state, owner_person_id: owner, data_json: JSON.stringify(data), archived });
  const resourceWrite = current
    ? db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, owner_person_id = ?, data_json = ?, archived = ?, updated_at = ? WHERE id = ?")
      .bind(version, state, owner, JSON.stringify(data), archived, timestamp, id)
    : db.prepare(`INSERT INTO simon_v3_resources
      (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .bind(id, route.kind, state, owner, JSON.stringify(data), archived, timestamp, timestamp);
  await db.batch([
    resourceWrite,
    db.prepare(`INSERT INTO simon_v3_operations
      (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role, status,
       resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, route.operationId, idempotencyKey, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(resourceRefs), JSON.stringify(steps), JSON.stringify(rollbackInfo), before, after, timestamp, timestamp),
    eventStatement(db, { traceId, route, actor, resourceId: id, operationId, outcome: "succeeded", evidence: { version } }),
  ]);
  return jsonResponse(operation, 202);
};

const query = async (context, route, actor, traceId) => {
  if (!isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
  const parsed = await readJson(context.request, traceId);
  if (parsed.error) return parsed.error;
  const bodyShapeIsValid = hasOnlyKeys(parsed.value, ["actor", "data"])
    && hasOnlyKeys(parsed.value?.actor, ["person_id", "role", "authority_grant_id"]);
  if (!bodyShapeIsValid || !actorMatches(actor, parsed.value?.actor) || !parsed.value?.data || typeof parsed.value.data !== "object" || Array.isArray(parsed.value.data)) {
    return problem(400, "validation_error", "Query actor and data are required and must match the authenticated actor", traceId);
  }
  if (route.operationId === "checkAvailability") {
    return checkCalendarAvailability(context, route, actor, traceId, parsed.value.data);
  }
  if (route.provider) {
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(502, "provider_failure", `${route.provider} query has no verified staging receipt`, traceId, "No provider result was represented as successful.");
  }
  return jsonResponse({ items: [], next_cursor: null });
};

export async function onRequest(context) {
  const suppliedTraceId = context.request.headers.get("x-simon-trace-id") || "";
  try {
    const route = matchSimonV3Route(context.request.method, new URL(context.request.url).pathname);
    if (!route) return problem(404, "not_found", "Simon V3 operation not found", suppliedTraceId);
    const authentication = authenticateSimonV3(context.request, context.env);
    if (authentication.error) return authentication.error;
    const { actor, traceId, credentialMode } = authentication;
    if (credentialMode === "shadow_read_only") {
      context.shadowReadOnlyCredential = true;
      if (route.mode === "mutation") {
        return problem(
          403, "shadow_read_only", "Shadow credentials cannot perform mutations",
          traceId, "No state was changed.",
        );
      }
    }
    const denied = requireRouteAccess(route, actor, traceId);
    if (denied) return denied;
    const invalidPath = validatePathIds(route, traceId);
    if (invalidPath) return invalidPath;
    if (route.trace && !isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
    if (route.mode === "mutation") return await mutate(context, route, actor, traceId);
    if (route.mode === "query") return await query(context, route, actor, traceId);
    const special = await readSpecial(context, route, actor, traceId);
    return special || await readResource(context, route, actor, traceId);
  } catch (error) {
    console.error("Simon V3 request failed safely", { error_type: clean(error?.name, 80) || "Error" });
    return problem(503, "provider_failure", "Simon V3 could not verify the operation", suppliedTraceId, "No success was recorded. Retry after checking staging dependencies.");
  }
}
