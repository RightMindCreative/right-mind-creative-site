import { json, requireAdmin } from "../../_lib/admin-auth.js";
import { ensureEmployeeScheduling } from "../../_lib/employee-scheduling.js";

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  await ensureEmployeeScheduling(context.env.APPLICATIONS_DB);

  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT a.id, a.created_at, a.updated_at, a.status, a.category, a.service,
      a.service_option, a.preferred_date, a.preferred_time, a.artist_name,
      a.first_name, a.last_name, a.email, a.phone, a.notes,
      sa.state AS assignment_state, sa.requested_by, sa.request_note
    FROM applications a
    LEFT JOIN session_assignments sa
      ON sa.application_id = a.id AND sa.employee_slug = 'jake-kaiser'
    WHERE a.preferred_date IS NOT NULL
      AND a.status NOT IN ('declined', 'cancelled')
    ORDER BY a.preferred_date ASC, a.preferred_time ASC
  `).all();

  return json({ sessions: (result.results || []).map((row) => ({
    id: row.id,
    status: row.status,
    category: row.category,
    service: row.service,
    serviceOption: row.service_option,
    preferredDate: row.preferred_date,
    preferredTime: row.preferred_time,
    artistName: row.artist_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    assignment: row.assignment_state ? {
      state: row.assignment_state,
      requestedBy: row.requested_by,
      requestNote: row.request_note,
    } : null,
  })) });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
