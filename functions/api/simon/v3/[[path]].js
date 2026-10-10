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
  getStripeHealth,
} from "../../../_lib/stripe.js";

const clean = (value, maximum = 500) => String(value || "").trim().slice(0, maximum);
const now = () => new Date().toISOString();

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
      error: String(error?.message || error),
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
      error: String(error?.message || error),
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
      console.error("Simon V3 staging Stripe health check failed safely", {
        error: String(error?.message || error),
      });
    }
    const items = [
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "d1", state: "ready", environment: "staging" }, evidence_refs: [] },
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "google_calendar", state: calendarVerified ? "ready" : "not_verified", environment: "staging", verified_at: latestCalendar?.created_at || null }, evidence_refs: [] },
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "stripe", state: stripe.state, mode: stripe.mode, environment: "staging" }, evidence_refs: [] },
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
}[operationId] || data.state || current || "active");

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
        operationId, error: String(error?.message || error),
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
        operationId, error: String(error?.message || error),
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
        operationId, error: String(error?.message || error),
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
      const receipt = await deleteCalendarEvent(context.env, providerEventId);
      const data = { ...currentData, booking_state: "cancelled" };
      const steps = [{
        name: route.operationId, status: "succeeded", provider_confirmed: true,
        provider_receipt_ref: `${providerEventId}:${receipt.status}`,
        retry_safe: true, error: null,
      }];
      await db.batch([
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

const rollback = async (context, route, actor, traceId, key, requestHash) => {
  const db = context.env.APPLICATIONS_DB;
  const source = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(route.params.operation_id).first();
  if (!source) return problem(404, "not_found", "Operation not found", traceId);
  const definition = JSON.parse(source.rollback_json || '{"available":false}');
  if (!definition.available) return problem(409, "invalid_transition", "That operation cannot be rolled back", traceId);
  const refs = JSON.parse(source.resource_refs_json || "[]");
  const target = refs[0];
  if (!target || !source.before_json) return problem(409, "invalid_transition", "Rollback evidence is incomplete", traceId);
  const before = JSON.parse(source.before_json);
  const timestamp = now();
  const operationId = crypto.randomUUID();
  const version = Number(target.version) + 1;
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
  if (route.provider) return failedProviderOperation(context, route, actor, traceId, idempotencyKey, requestHash);

  const id = targetId || (isUuid(body.data.id) ? body.data.id : crypto.randomUUID());
  const timestamp = now();
  const version = current ? Number(current.version) + 1 : 1;
  const data = { ...(current ? JSON.parse(current.data_json) : {}), ...body.data, id };
  const requestedOwner = clean(body.data.owner_person_id, 36);
  const owner = ["admin", "system"].includes(actor.role)
    ? (requestedOwner || current?.owner_person_id || null)
    : (current?.owner_person_id || actor.person_id);
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
    const { actor, traceId } = authentication;
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
    console.error("Simon V3 request failed safely", { error: String(error?.message || error) });
    return problem(503, "provider_failure", "Simon V3 could not verify the operation", suppliedTraceId, "No success was recorded. Retry after checking staging dependencies.");
  }
}
