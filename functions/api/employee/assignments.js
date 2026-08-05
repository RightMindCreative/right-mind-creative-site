import { json } from "../../_lib/admin-auth.js";
import { employeeProfile, requireEmployee } from "../../_lib/employee-auth.js";
import { calendarEligibleApplication, ensureEmployeeScheduling } from "../../_lib/employee-scheduling.js";
import { notifySimonOfEngineerResponse } from "../../_lib/simon-notifications.js";

const allowedActions = new Set(["request", "accept", "decline"]);

export async function onRequestPost(context) {
  const unauthorized = await requireEmployee(context);
  if (unauthorized) return unauthorized;
  const body = await context.request.json().catch(() => ({}));
  const action = String(body.action || "").toLowerCase();
  const applicationId = String(body.applicationId || "");
  const note = String(body.note || "").trim().slice(0, 1000) || null;
  if (!applicationId || !allowedActions.has(action)) return json({ error: "Choose a valid scheduling action." }, 422);

  const db = context.env.APPLICATIONS_DB;
  await ensureEmployeeScheduling(db);
  const application = await db.prepare("SELECT * FROM applications WHERE id = ?").bind(applicationId).first();
  if (!calendarEligibleApplication(application)) return json({ error: "This session is not available for assignment." }, 409);
  const assignment = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ? AND employee_slug = ?",
  ).bind(applicationId, employeeProfile.slug).first();
  const now = new Date().toISOString();

  if (action === "request") {
    if (assignment && ["requested_owner", "accepted"].includes(assignment.state)) {
      return json({ error: assignment.state === "accepted"
        ? "You are already responsible for this session."
        : "Ryan has already requested you for this session." }, 409);
    }
    await db.prepare(`
      INSERT INTO session_assignments
        (id, application_id, employee_slug, employee_name, state, requested_by,
         request_note, requested_at, updated_at)
      VALUES (?, ?, ?, ?, 'requested_employee', 'employee', ?, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET
        state = 'requested_employee', requested_by = 'employee', request_note = excluded.request_note,
        response_note = NULL, requested_at = excluded.requested_at, responded_at = NULL,
        updated_at = excluded.updated_at
    `).bind(
      assignment?.id || crypto.randomUUID(), applicationId, employeeProfile.slug,
      employeeProfile.name, note, now, now,
    ).run();
  } else {
    if (!assignment || assignment.state !== "requested_owner") {
      return json({ error: "There is no owner request awaiting your response." }, 409);
    }
    await db.prepare(`
      UPDATE session_assignments SET state = ?, response_note = ?, responded_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(action === "accept" ? "accepted" : "declined", note, now, now, assignment.id).run();
  }

  const saved = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ? AND employee_slug = ?",
  ).bind(applicationId, employeeProfile.slug).first();
  const notification = action === "request"
    ? { status: "not_applicable" }
    : await notifySimonOfEngineerResponse(saved, application, context.env);
  return json({ assignment: saved, notificationStatus: notification.status });
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
