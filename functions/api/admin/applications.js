import { json, requireAdmin } from "../../_lib/admin-auth.js";

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT
      a.id, a.created_at, a.updated_at, a.status, a.category, a.service,
      a.service_option, a.preferred_date, a.preferred_time,
      a.first_name, a.last_name, a.artist_name, a.email, a.phone,
      a.stem_count, a.social_links, a.notes, a.google_event_id,
      a.calendar_sync_status, a.email_notification_status,
      COUNT(f.id) AS file_count
    FROM applications a
    LEFT JOIN application_files f ON f.application_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at DESC
    LIMIT 200
  `).all();

  return json({ applications: result.results || [] });
}
