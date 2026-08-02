import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";

const displayName = (row) => row.artist_name || `${row.first_name || ""} ${row.last_name || ""}`.trim();
const normalizedEmail = (value) => String(value || "").trim().toLowerCase();

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const name = (new URL(context.request.url).searchParams.get("name") || "").trim();
  if (!name) return json({ error: "An artist name is required." }, 400);
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

  return json({ artists: [...artists.values()].map((artist) => ({
    id: String(artist.id || ""),
    name: displayName(artist),
    phone: String(artist.phone || ""),
    email: String(artist.email || ""),
  })) });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
