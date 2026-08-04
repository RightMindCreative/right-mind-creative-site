import { json, requireAdmin } from "../../../_lib/admin-auth.js";
import { ensureEmployeeScheduling } from "../../../_lib/employee-scheduling.js";

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const application = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM applications WHERE id = ?
  `).bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);
  await ensureEmployeeScheduling(context.env.APPLICATIONS_DB);

  const files = await context.env.APPLICATIONS_DB.prepare(`
    SELECT id, original_name, content_type, size_bytes, created_at
    FROM application_files
    WHERE application_id = ?
    ORDER BY created_at
  `).bind(context.params.id).all();

  const assignment = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM session_assignments WHERE application_id = ? LIMIT 1
  `).bind(context.params.id).first();

  return json({ application, files: files.results || [], assignment: assignment || null });
}
