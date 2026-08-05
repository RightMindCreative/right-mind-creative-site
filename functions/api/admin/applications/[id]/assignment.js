import { json, requireAdmin } from "../../../../_lib/admin-auth.js";
import { employeeProfile } from "../../../../_lib/employee-auth.js";
import { calendarEligibleApplication, ensureEmployeeScheduling } from "../../../../_lib/employee-scheduling.js";

const actions = new Set(["request", "accept", "decline", "cancel"]);

export async function onRequestPost(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  const body = await context.request.json().catch(() => ({}));
  const action = String(body.action || "").toLowerCase();
  const note = String(body.note || "").trim().slice(0, 1000) || null;
  if (!actions.has(action)) return json({ error: "Choose a valid assignment action." }, 422);

  const db = context.env.APPLICATIONS_DB;
  await ensureEmployeeScheduling(db);
  const application = await db.prepare("SELECT * FROM applications WHERE id = ?").bind(context.params.id).first();
  if (!calendarEligibleApplication(application)) return json({ error: "This session cannot be assigned." }, 409);
  const existing = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ?",
  ).bind(application.id).first();
  const now = new Date().toISOString();

  if (["accept", "decline"].includes(action)) {
    if (!existing || existing.state !== "requested_employee") {
      return json({ error: "Jake does not have a request awaiting your response." }, 409);
    }
    await db.prepare(`UPDATE session_assignments
      SET state = ?, response_note = ?, responded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(action === "accept" ? "accepted" : "declined", note, now, now, existing.id).run();
  } else if (action === "cancel") {
    if (!existing) return json({ error: "There is no assignment to cancel." }, 409);
    await db.prepare(`UPDATE session_assignments
      SET state = 'cancelled', response_note = ?, responded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(note, now, now, existing.id).run();
  } else if (existing) {
    await db.prepare(`UPDATE session_assignments SET
      employee_slug = ?, employee_name = ?, state = 'requested_owner',
      requested_by = 'owner', request_note = ?, response_note = NULL,
      requested_at = ?, responded_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(employeeProfile.slug, employeeProfile.name, note, now, now, existing.id).run();
  } else {
    await db.prepare(`INSERT INTO session_assignments
      (id, application_id, employee_slug, employee_name, state, requested_by,
       request_note, requested_at, updated_at)
      VALUES (?, ?, ?, ?, 'requested_owner', 'owner', ?, ?, ?)`)
      .bind(crypto.randomUUID(), application.id, employeeProfile.slug,
        employeeProfile.name, note, now, now).run();
  }
  const assignment = await db.prepare(
    "SELECT * FROM session_assignments WHERE application_id = ?",
  ).bind(application.id).first();
  return json({ assignment });
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context).catch((error) => {
    console.error("Admin engineer assignment failed", { applicationId: context.params.id, error });
    return json({ error: "The engineer request could not be saved. Please refresh and try again." }, 500);
  });
  return json({ error: "Method not allowed." }, 405);
}
