import { json, requireAdmin } from "../../../_lib/admin-auth.js";

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const application = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM applications WHERE id = ?
  `).bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);

  const files = await context.env.APPLICATIONS_DB.prepare(`
    SELECT id, original_name, content_type, size_bytes, created_at
    FROM application_files
    WHERE application_id = ?
    ORDER BY created_at
  `).bind(context.params.id).all();

  return json({ application, files: files.results || [] });
}
