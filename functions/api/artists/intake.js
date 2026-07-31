const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const ensureManualArtists = (db) => db.prepare(`
  CREATE TABLE IF NOT EXISTS manual_artists (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    first_name TEXT, last_name TEXT, artist_name TEXT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT,
    social_links TEXT, notes TEXT
  )
`).run();

export async function onRequestPost(context) {
  if (!context.env.APPLICATIONS_DB) return json({ error: "The artist directory is not configured yet." }, 503);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "Your information could not be read." }, 400); }
  if (String(payload.company_website || "").trim()) return json({ received: true }, 201);

  const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
  const artist = {
    first_name: clean(payload.first_name, 100), last_name: clean(payload.last_name, 100),
    artist_name: clean(payload.artist_name, 160), email: clean(payload.email, 254).toLowerCase(),
    phone: clean(payload.phone, 60), social_links: clean(payload.social_links, 2000),
    notes: clean(payload.notes, 5000),
  };
  if (!artist.first_name || !artist.last_name) return json({ error: "Enter your first and last name." }, 422);
  if (!/^\S+@\S+\.\S+$/.test(artist.email)) return json({ error: "Enter a valid email address." }, 422);
  if (!artist.phone) return json({ error: "Enter a phone number." }, 422);

  await ensureManualArtists(context.env.APPLICATIONS_DB);
  const existing = await context.env.APPLICATIONS_DB.prepare(
    "SELECT id, created_at FROM manual_artists WHERE email = ? COLLATE NOCASE",
  ).bind(artist.email).first();
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  if (existing) {
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE manual_artists SET updated_at = ?, first_name = ?, last_name = ?,
        artist_name = ?, phone = ?, social_links = ?, notes = ? WHERE id = ?
    `).bind(now, artist.first_name, artist.last_name, artist.artist_name, artist.phone, artist.social_links, artist.notes, id).run();
  } else {
    await context.env.APPLICATIONS_DB.prepare(`
      INSERT INTO manual_artists
        (id, created_at, updated_at, first_name, last_name, artist_name, email, phone, social_links, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, now, now, artist.first_name, artist.last_name, artist.artist_name, artist.email, artist.phone, artist.social_links, artist.notes).run();
  }
  return json({ received: true, updated: Boolean(existing) }, existing ? 200 : 201);
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
