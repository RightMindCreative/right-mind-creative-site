import { json } from "../../_lib/admin-auth.js";
import { employeeProfile, requireEmployee } from "../../_lib/employee-auth.js";
import { ensureEmployeeScheduling } from "../../_lib/employee-scheduling.js";

export async function onRequestGet(context) {
  const unauthorized = await requireEmployee(context);
  if (unauthorized) return unauthorized;
  await ensureEmployeeScheduling(context.env.APPLICATIONS_DB);

  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT a.id, a.created_at, a.updated_at, a.status, a.category, a.service,
      a.service_option, a.preferred_date, a.preferred_time, a.artist_name,
      a.first_name, a.last_name, a.email, a.phone, a.notes,
      sa.id AS assignment_id, sa.state AS assignment_state,
      sa.requested_by, sa.request_note, sa.response_note, sa.requested_at,
      sa.responded_at, sa.updated_at AS assignment_updated_at
    FROM applications a
    LEFT JOIN session_assignments sa
      ON sa.application_id = a.id AND sa.employee_slug = ?
    WHERE a.preferred_date IS NOT NULL
      AND a.category != 'mixing'
      AND a.service != 'Custom Project'
      AND a.status NOT IN ('declined', 'cancelled')
    ORDER BY a.preferred_date ASC, a.preferred_time ASC
  `).bind(employeeProfile.slug).all();

  const sessions = (result.results || []).map((row) => {
    const accepted = row.assignment_state === "accepted";
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      category: row.category,
      service: row.service,
      serviceOption: row.service_option,
      preferredDate: row.preferred_date,
      preferredTime: row.preferred_time,
      artistName: row.artist_name || `${row.first_name} ${row.last_name}`.trim(),
      contact: accepted ? { email: row.email, phone: row.phone } : null,
      notes: accepted ? row.notes : null,
      assignment: row.assignment_id ? {
        id: row.assignment_id,
        state: row.assignment_state,
        requestedBy: row.requested_by,
        requestNote: row.request_note,
        responseNote: row.response_note,
        requestedAt: row.requested_at,
        respondedAt: row.responded_at,
        updatedAt: row.assignment_updated_at,
      } : null,
    };
  });

  return json({ employee: employeeProfile, sessions });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
