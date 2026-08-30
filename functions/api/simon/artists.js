import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";

const normalizedEmail = (value) => String(value || "").trim().toLowerCase();
export const normalizedPhone = (value) => String(value || "").replace(/\D/g, "").slice(-10);
export const artistSummary = (artist) => {
  const fullName = `${artist.first_name || ""} ${artist.last_name || ""}`.trim();
  const artistName = String(artist.artist_name || "").trim();
  return {
    id: String(artist.id || ""),
    fullName,
    artistName,
    greetingName: artistName || fullName,
    phone: String(artist.phone || ""),
    email: String(artist.email || ""),
  };
};

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const searchParams = new URL(context.request.url).searchParams;
  const name = (searchParams.get("name") || "").trim();
  const phone = normalizedPhone(searchParams.get("phone"));
  const email = normalizedEmail(searchParams.get("email"));
  if (!name && !phone && !email) {
    return json({ error: "An artist name, email, or phone is required." }, 400);
  }
  if (email) {
    const [manualResult, applicationResult] = await Promise.all([
      context.env.APPLICATIONS_DB.prepare(`
        SELECT id, first_name, last_name, artist_name, email, phone
        FROM manual_artists
        WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(linked_email)) = ?
        ORDER BY updated_at DESC LIMIT 1
      `).bind(email, email).all(),
      context.env.APPLICATIONS_DB.prepare(`
        SELECT id, first_name, last_name, artist_name, email, phone
        FROM applications
        WHERE status IN ('approved', 'payment_pending', 'confirmed')
          AND LOWER(TRIM(email)) = ?
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1
      `).bind(email).all(),
    ]);
    const rows = [...(manualResult.results || []), ...(applicationResult.results || [])];
    return json({ artists: rows.slice(0, 1).map(artistSummary) });
  }
  if (phone) {
    const [manualResult, applicationResult] = await Promise.all([
      context.env.APPLICATIONS_DB.prepare(`
        SELECT id, first_name, last_name, artist_name, email, phone
        FROM manual_artists WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), '(', ''), ')', ''), ' ', '') LIKE ?
        LIMIT 1
      `).bind(`%${phone}`).all(),
      context.env.APPLICATIONS_DB.prepare(`
        SELECT id, first_name, last_name, artist_name, email, phone
        FROM applications
        WHERE status IN ('approved', 'payment_pending', 'confirmed')
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), '(', ''), ')', ''), ' ', '') LIKE ?
        LIMIT 1
      `).bind(`%${phone}`).all(),
    ]);
    const rows = [...(manualResult.results || []), ...(applicationResult.results || [])];
    return json({ artists: rows.slice(0, 1).map(artistSummary) });
  }
  const pattern = `%${name.replace(/[\\%_]/g, "\\$&")}%`;

  const [manualResult, applicationResult] = await Promise.all([
    context.env.APPLICATIONS_DB.prepare(`
      SELECT id, first_name, last_name, artist_name, email, phone, linked_email, updated_at
      FROM manual_artists
      WHERE artist_name LIKE ? ESCAPE '\\' COLLATE NOCASE
         OR TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY updated_at DESC LIMIT 25
    `).bind(pattern, pattern).all(),
    context.env.APPLICATIONS_DB.prepare(`
      SELECT id, first_name, last_name, artist_name, email, phone,
             COALESCE(updated_at, created_at) AS updated_at
      FROM applications
      WHERE status IN ('approved', 'payment_pending', 'confirmed')
        AND (artist_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR TRIM(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50
    `).bind(pattern, pattern).all(),
  ]);

  const artists = new Map();
  for (const row of applicationResult.results || []) {
    const key = normalizedEmail(row.email) || row.id;
    if (!artists.has(key)) artists.set(key, row);
  }
  for (const manual of manualResult.results || []) {
    const linkedKey = normalizedEmail(manual.linked_email);
    const emailKey = normalizedEmail(manual.email);
    const existing = artists.get(linkedKey) || artists.get(emailKey);
    if (existing) {
      artists.delete(linkedKey);
      artists.delete(emailKey);
    }
    artists.set(emailKey || manual.id, {
      ...existing,
      ...manual,
      first_name: manual.first_name || existing?.first_name,
      last_name: manual.last_name || existing?.last_name,
      artist_name: manual.artist_name || existing?.artist_name,
      phone: manual.phone || existing?.phone,
    });
  }

  return json({ artists: [...artists.values()].map(artistSummary) });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
