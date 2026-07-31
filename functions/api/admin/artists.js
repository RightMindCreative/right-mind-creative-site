import { json, requireAdmin } from "../../_lib/admin-auth.js";

const approvedStatuses = ["approved", "payment_pending", "confirmed"];

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

  const manualResult = await context.env.APPLICATIONS_DB.prepare(`
    SELECT * FROM manual_artists ORDER BY updated_at DESC
  `).all();
  for (const manual of manualResult.results || []) {
    const key = String(manual.linked_email || manual.email).trim().toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      Object.assign(existing, {
        id: manual.id, source: "manual",
        first_name: manual.first_name || existing.first_name,
        last_name: manual.last_name || existing.last_name,
        artist_name: manual.artist_name || existing.artist_name,
        email: manual.email, linked_email: manual.linked_email, phone: manual.phone || existing.phone,
        social_links: manual.social_links || existing.social_links,
        notes: manual.notes,
      });
    } else {
      grouped.set(key, {
        ...manual, source: "manual", latest_service: "Manually added",
        latest_status: "artist", latest_activity: manual.updated_at,
        first_application: manual.created_at, application_count: 0,
        confirmed_count: 0, file_count: 0,
      });
    }
  }

  return json({
    artists: [...grouped.values()],
    approved_statuses: approvedStatuses,
  });
}

export async function onRequestPost(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  await ensureManualArtists(context.env.APPLICATIONS_DB);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The artist details could not be read." }, 400); }

  const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
  const artist = {
    id: crypto.randomUUID(), first_name: clean(payload.first_name, 100),
    last_name: clean(payload.last_name, 100), artist_name: clean(payload.artist_name, 160),
    email: clean(payload.email, 254).toLowerCase(), phone: clean(payload.phone, 60),
    social_links: clean(payload.social_links, 2000), notes: clean(payload.notes, 5000),
  };
  if (!artist.artist_name && !artist.first_name && !artist.last_name) return json({ error: "Add an artist name or customer name." }, 422);
  if (!/^\S+@\S+\.\S+$/.test(artist.email)) return json({ error: "Add a valid email address." }, 422);
  const now = new Date().toISOString();
  try {
    await context.env.APPLICATIONS_DB.prepare(`
      INSERT INTO manual_artists
        (id, created_at, updated_at, first_name, last_name, artist_name, email, phone, social_links, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(artist.id, now, now, artist.first_name, artist.last_name, artist.artist_name, artist.email, artist.phone, artist.social_links, artist.notes).run();
  } catch (error) {
    if (String(error.message || error).toLowerCase().includes("unique")) return json({ error: "An artist with that email already exists." }, 409);
    throw error;
  }
  return json({ artist: { ...artist, created_at: now, updated_at: now, source: "manual", application_count: 0, confirmed_count: 0 } }, 201);
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
