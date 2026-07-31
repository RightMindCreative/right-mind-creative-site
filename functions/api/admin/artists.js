import { json, requireAdmin } from "../../_lib/admin-auth.js";

const approvedStatuses = ["approved", "payment_pending", "confirmed"];

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT
      a.id, a.created_at, a.updated_at, a.status, a.service,
      a.first_name, a.last_name, a.artist_name, a.email, a.phone,
      a.social_links, a.deposit_status, a.deposit_paid_at,
      COUNT(f.id) AS file_count
    FROM applications a
    LEFT JOIN application_files f ON f.application_id = a.id
    WHERE a.status IN ('approved', 'payment_pending', 'confirmed')
    GROUP BY a.id
    ORDER BY COALESCE(a.deposit_paid_at, a.decided_at, a.updated_at, a.created_at) DESC
    LIMIT 1000
  `).all();

  const grouped = new Map();
  for (const application of result.results || []) {
    const key = String(application.email || "").trim().toLowerCase();
    if (!key) continue;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        id: application.id,
        first_name: application.first_name,
        last_name: application.last_name,
        artist_name: application.artist_name,
        email: application.email,
        phone: application.phone,
        social_links: application.social_links,
        latest_service: application.service,
        latest_status: application.status,
        latest_activity: application.deposit_paid_at || application.updated_at || application.created_at,
        first_application: application.created_at,
        application_count: 1,
        confirmed_count: application.status === "confirmed" ? 1 : 0,
        file_count: Number(application.file_count) || 0,
      });
      continue;
    }
    existing.application_count += 1;
    existing.confirmed_count += application.status === "confirmed" ? 1 : 0;
    existing.file_count += Number(application.file_count) || 0;
    if (application.created_at < existing.first_application) existing.first_application = application.created_at;
    if (!existing.phone && application.phone) existing.phone = application.phone;
    if (!existing.artist_name && application.artist_name) existing.artist_name = application.artist_name;
    if (!existing.social_links && application.social_links) existing.social_links = application.social_links;
  }

  return json({
    artists: [...grouped.values()],
    approved_statuses: approvedStatuses,
  });
}
