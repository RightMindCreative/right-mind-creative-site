import { json, requireAdmin } from "../../../_lib/admin-auth.js";

const ensureManualArtists = async (db) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS manual_artists (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    first_name TEXT, last_name TEXT, artist_name TEXT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT,
    social_links TEXT, notes TEXT
  )`).run();
  try { await db.prepare("ALTER TABLE manual_artists ADD COLUMN linked_email TEXT").run(); }
  catch (error) { if (!String(error.message || error).toLowerCase().includes("duplicate column")) throw error; }
};

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;

  await ensureManualArtists(context.env.APPLICATIONS_DB);
  const manual = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM manual_artists WHERE id = ?",
  ).bind(context.params.id).first();
  const representative = manual || await context.env.APPLICATIONS_DB.prepare(`
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
  `).bind(manual?.linked_email || representative.email).all();

  const rows = applications.results || [];
  const latest = rows[0] || representative;
  return json({
    artist: {
      id: representative.id,
      source: manual ? "manual" : "application",
      first_name: manual?.first_name || latest.first_name || representative.first_name,
      last_name: manual?.last_name || latest.last_name || representative.last_name,
      artist_name: manual?.artist_name || latest.artist_name || representative.artist_name,
      email: manual?.email || representative.email,
      phone: manual?.phone || latest.phone || representative.phone,
      social_links: manual?.social_links || latest.social_links || representative.social_links,
      notes: manual?.notes || latest.notes || representative.notes,
      first_application: rows.at(-1)?.created_at || manual?.created_at || representative.created_at,
      latest_activity: latest.deposit_paid_at || latest.updated_at || latest.created_at,
      application_count: rows.length,
      confirmed_count: rows.filter((row) => row.status === "confirmed").length,
    },
    applications: rows,
  });
}

export async function onRequestPatch(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  const db = context.env.APPLICATIONS_DB;
  await ensureManualArtists(db);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The artist details could not be read." }, 400); }
  const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
  const values = {
    first_name: clean(payload.first_name, 100), last_name: clean(payload.last_name, 100),
    artist_name: clean(payload.artist_name, 160), email: clean(payload.email, 254).toLowerCase(),
    phone: clean(payload.phone, 60), social_links: clean(payload.social_links, 2000),
    notes: clean(payload.notes, 5000),
  };
  if (!values.artist_name && !values.first_name && !values.last_name) return json({ error: "Add an artist name or customer name." }, 422);
  if (!/^\S+@\S+\.\S+$/.test(values.email)) return json({ error: "Add a valid email address." }, 422);

  const manual = await db.prepare("SELECT * FROM manual_artists WHERE id = ?").bind(context.params.id).first();
  const application = manual ? null : await db.prepare(`
    SELECT * FROM applications WHERE id = ? AND status IN ('approved', 'payment_pending', 'confirmed')
  `).bind(context.params.id).first();
  if (!manual && !application) return json({ error: "Artist not found." }, 404);
  const id = manual?.id || crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    if (manual) {
      await db.prepare(`UPDATE manual_artists SET updated_at = ?, first_name = ?, last_name = ?,
        artist_name = ?, email = ?, phone = ?, social_links = ?, notes = ? WHERE id = ?
      `).bind(now, values.first_name, values.last_name, values.artist_name, values.email, values.phone, values.social_links, values.notes, id).run();
    } else {
      await db.prepare(`INSERT INTO manual_artists
        (id, created_at, updated_at, first_name, last_name, artist_name, email, phone, social_links, notes, linked_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, now, now, values.first_name, values.last_name, values.artist_name, values.email, values.phone, values.social_links, values.notes, application.email).run();
    }
  } catch (error) {
    if (String(error.message || error).toLowerCase().includes("unique")) return json({ error: "Another artist already uses that email address." }, 409);
    throw error;
  }
  return json({ artist: { id, ...values, source: "manual" } });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "PATCH") return onRequestPatch(context);
  return json({ error: "Method not allowed." }, 405);
}
