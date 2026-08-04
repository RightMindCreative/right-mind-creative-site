import { requireAdmin } from "../../_lib/admin-auth.js";
import {
  reconcileApplicationCalendar,
} from "../../_lib/application-notifications.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

export async function onRequestPost(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const { id = "" } = await context.request.json().catch(() => ({}));
  if (!id) return json({ error: "Application ID is required." }, 400);

  const row = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ? LIMIT 1",
  ).bind(id).first();
  if (!row) return json({ error: "Application not found." }, 404);

  const files = await context.env.APPLICATIONS_DB.prepare(`
    SELECT id, object_key, original_name, content_type, size_bytes
    FROM application_files
    WHERE application_id = ?
    ORDER BY created_at ASC
  `).bind(id).all();

  const storedFiles = (files.results || []).map((file) => ({
    id: file.id,
    objectKey: file.object_key,
    name: file.original_name,
    type: file.content_type,
    size: file.size_bytes,
  }));

  try {
    const result = await reconcileApplicationCalendar(row, storedFiles, context.env);
    const eventId = result.eventId;

    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET updated_at = ?, google_event_id = ?, calendar_sync_status = ?, calendar_sync_error = NULL
      WHERE id = ?
    `).bind(new Date().toISOString(), eventId || null, result.status, id).run();
    return json({ id, calendar: { ...result, eventId } });
  } catch (error) {
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET updated_at = ?, calendar_sync_status = 'failed', calendar_sync_error = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), String(error?.message || error).slice(0, 500), id).run();
    return json({ error: "Calendar retry failed.", detail: String(error?.message || error) }, 502);
  }
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
