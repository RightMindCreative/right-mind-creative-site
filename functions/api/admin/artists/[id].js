import { json, requireAdmin } from "../../../_lib/admin-auth.js";

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  const representative = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM applications
    WHERE id = ? AND status IN ('approved', 'payment_pending', 'confirmed')
  `).bind(context.params.id).first();
  if (!representative) return json({ error: "Artist not found." }, 404);

  const applications = await context.env.APPLICATIONS_DB.prepare(`
    SELECT
      a.*, COUNT(f.id) AS file_count
    FROM applications a
    LEFT JOIN application_files f ON f.application_id = a.id
    WHERE LOWER(TRIM(a.email)) = LOWER(TRIM(?))
      AND a.status IN ('approved', 'payment_pending', 'confirmed')
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).bind(representative.email).all();

  const rows = applications.results || [];
  const latest = rows[0] || representative;
  return json({
    artist: {
      id: representative.id,
      first_name: latest.first_name || representative.first_name,
      last_name: latest.last_name || representative.last_name,
      artist_name: latest.artist_name || representative.artist_name,
      email: representative.email,
      phone: latest.phone || representative.phone,
      social_links: latest.social_links || representative.social_links,
      notes: latest.notes || representative.notes,
      first_application: rows.at(-1)?.created_at || representative.created_at,
      latest_activity: latest.deposit_paid_at || latest.updated_at || latest.created_at,
      application_count: rows.length,
      confirmed_count: rows.filter((row) => row.status === "confirmed").length,
    },
    applications: rows,
  });
}
