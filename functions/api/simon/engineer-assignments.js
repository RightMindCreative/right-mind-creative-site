import { json } from "../../_lib/admin-auth.js";
import { employeeProfile } from "../../_lib/employee-auth.js";
import { calendarEligibleApplication, ensureEmployeeScheduling } from "../../_lib/employee-scheduling.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";

const clean = (value, length = 500) => String(value || "").trim().slice(0, length);
const teamUrl = (context, applicationId) => {
  const origin = context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin;
  return `${origin}/team/?session=${encodeURIComponent(applicationId)}&view=requests`;
};

export const preferredStartsAt = (date, time) => {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return `${date}T00:00:00-06:00`;
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  const probe = new Date(`${date}T12:00:00Z`);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT-06:00";
  const offset = zoneName.replace("GMT", "") || "-06:00";
  return `${date}T${String(hour).padStart(2, "0")}:${match[2]}:00${offset}`;
};

const assignmentResponse = (context, assignment, application) => ({
  id: assignment.id,
  engineerName: assignment.employee_name,
  startsAt: preferredStartsAt(application.preferred_date, application.preferred_time),
  durationMinutes: Number.parseFloat(application.service_option || "0") * 60 || 0,
  sessionDescription: `${application.artist_name || `${application.first_name} ${application.last_name}`.trim()} · ${application.service}`,
  status: assignment.state === "accepted" ? "approved" : assignment.state,
  responseUrl: teamUrl(context, application.id),
});

export async function onRequestPost(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"), 200);
  if (!idempotencyKey) return json({ error: "An Idempotency-Key header is required." }, 400);
  const payload = await context.request.json().catch(() => ({}));
  const startsAt = new Date(payload.startsAt || "");
  if (Number.isNaN(startsAt.getTime())) return json({ error: "A valid session start is required." }, 422);

  const central = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(startsAt).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const date = `${central.year}-${central.month}-${central.day}`;
  const time = `${central.hour}:${central.minute} ${central.dayPeriod}`;
  const db = context.env.APPLICATIONS_DB;
  await ensureEmployeeScheduling(db);

  const previous = await db.prepare(`
    SELECT application_id FROM simon_api_audit
    WHERE action = 'engineer_assignment.create' AND idempotency_key = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(idempotencyKey).first();
  let application;
  if (previous?.application_id) {
    application = await db.prepare("SELECT * FROM applications WHERE id = ?")
      .bind(previous.application_id).first();
  } else {
    const candidates = await db.prepare(`
      SELECT * FROM applications
      WHERE preferred_date = ? AND preferred_time = ?
        AND status NOT IN ('declined', 'cancelled')
      ORDER BY updated_at DESC LIMIT 2
    `).bind(date, time).all();
    if ((candidates.results || []).length !== 1) {
      return json({ error: candidates.results?.length
        ? "More than one session matches that start time."
        : "No session matches that start time." }, 409);
    }
    [application] = candidates.results;
  }
  if (!calendarEligibleApplication(application)) {
    return json({ error: "This session cannot be assigned to an engineer." }, 409);
  }

  const existing = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ?",
  ).bind(application.id).first();
  const now = new Date().toISOString();
  if (!previous) {
    await db.batch([
      db.prepare(`
        INSERT INTO session_assignments
          (id, application_id, employee_slug, employee_name, state, requested_by,
           request_note, requested_at, updated_at)
        VALUES (?, ?, ?, ?, 'requested_owner', 'owner', ?, ?, ?)
        ON CONFLICT(application_id) DO UPDATE SET
          employee_slug = excluded.employee_slug, employee_name = excluded.employee_name,
          state = 'requested_owner', requested_by = 'owner', request_note = excluded.request_note,
          response_note = NULL, requested_at = excluded.requested_at, responded_at = NULL,
          updated_at = excluded.updated_at
      `).bind(
        existing?.id || crypto.randomUUID(), application.id, employeeProfile.slug,
        employeeProfile.name, clean(payload.sessionDescription, 1000) || null, now, now,
      ),
      db.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'engineer_assignment.create', ?, ?, ?, 'requested_owner')
      `).bind(crypto.randomUUID(), now, context.request.headers.get("x-request-id") || "", idempotencyKey, application.id),
    ]);
  }
  const assignment = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ?",
  ).bind(application.id).first();
  return json({ created: true, assignment: assignmentResponse(context, assignment, application) }, previous ? 200 : 201);
}

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const url = new URL(context.request.url);
  const date = clean(url.searchParams.get("date"), 10);
  const requestedStatus = clean(url.searchParams.get("status"), 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || requestedStatus !== "approved") {
    return json({ error: "A date and approved status are required." }, 422);
  }
  await ensureEmployeeScheduling(context.env.APPLICATIONS_DB);
  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT sa.*, a.preferred_date, a.preferred_time, a.service_option, a.service,
      a.artist_name, a.first_name, a.last_name
    FROM session_assignments sa JOIN applications a ON a.id = sa.application_id
    WHERE sa.employee_slug = ? AND sa.state = 'accepted' AND a.preferred_date = ?
    ORDER BY a.preferred_time ASC
  `).bind(employeeProfile.slug, date).all();
  return json({ assignments: (result.results || []).map((item) => assignmentResponse(context, item, item)) });
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
