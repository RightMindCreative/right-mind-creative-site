import { json, requireAdmin } from "../../_lib/admin-auth.js";
import { calendarIsConfigured, listCalendarEvents } from "../../_lib/google-calendar.js";

const MATCHES = [
  { query: "Elizabeth", test: /\belizabeth\b/i, artistName: "Elizabeth Weiss" },
  { query: "Hunnidband", test: /\bhunnidband\b/i, artistName: "Hunnidband Lindo" },
  { query: "Alex Osborne", test: /\balex\s+osborne\b/i, artistName: "Alex Osborne" },
];
const TIME_MIN = "2023-01-01T00:00:00-06:00";
const TIME_ZONE = "America/Chicago";

const eventRange = (event, timeZone) => {
  if (!event.start?.dateTime || !event.end?.dateTime) return null;
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(start).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const hours = Math.max(0.25, (end.getTime() - start.getTime()) / 3600000);
  const duration = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 4) / 4);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    serviceOption: `${duration} hour${hours === 1 ? "" : "s"}`,
  };
};

const loadMatches = async (env) => {
  const seen = new Set();
  const matches = [];
  let scannedCount = 0;
  for (const mapping of MATCHES) {
    const events = await listCalendarEvents(env, { query: mapping.query, timeMin: TIME_MIN });
    scannedCount += events.length;
    for (const event of events) {
      if (seen.has(event.id) || !mapping.test.test(event.summary || "")) continue;
      const range = eventRange(event, env.BOOKING_TIME_ZONE || TIME_ZONE);
      if (!range) continue;
      seen.add(event.id);
      matches.push({ event, mapping, range });
    }
  }
  return {
    matches: matches.sort((a, b) => a.event.start.dateTime.localeCompare(b.event.start.dateTime)),
    scannedCount,
  };
};

const findArtist = async (db, artistName) => db.prepare(`
  SELECT * FROM manual_artists
  WHERE LOWER(TRIM(artist_name)) = LOWER(TRIM(?))
     OR LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) = LOWER(TRIM(?))
  LIMIT 1
`).bind(artistName, artistName).first();

const publicMatch = async (db, match) => {
  const existing = await db.prepare("SELECT id FROM applications WHERE google_event_id = ? LIMIT 1")
    .bind(match.event.id).first();
  return {
    googleEventId: match.event.id,
    title: match.event.summary || "Untitled calendar event",
    start: match.event.start.dateTime,
    end: match.event.end.dateTime,
    artistName: match.mapping.artistName,
    alreadyImported: Boolean(existing),
  };
};

export async function onRequestGet(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  if (!calendarIsConfigured(context.env)) return json({ error: "Google Calendar is not configured." }, 503);
  const scan = await loadMatches(context.env);
  return json({
    scannedCount: scan.scannedCount,
    matches: await Promise.all(scan.matches.map((match) => publicMatch(context.env.APPLICATIONS_DB, match))),
  });
}

export async function onRequestPost(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  if (!calendarIsConfigured(context.env)) return json({ error: "Google Calendar is not configured." }, 503);
  const db = context.env.APPLICATIONS_DB;
  const scan = await loadMatches(context.env);
  const now = new Date().toISOString();
  const imported = [];
  const skipped = [];
  const missingArtists = [];

  for (const match of scan.matches) {
    const duplicate = await db.prepare("SELECT id FROM applications WHERE google_event_id = ? LIMIT 1")
      .bind(match.event.id).first();
    if (duplicate) { skipped.push({ eventId: match.event.id, reason: "already_imported" }); continue; }
    const artist = await findArtist(db, match.mapping.artistName);
    if (!artist) { missingArtists.push(match.mapping.artistName); continue; }
    const id = crypto.randomUUID();
    const firstName = artist.first_name || match.mapping.artistName.split(" ")[0] || "Artist";
    const lastName = artist.last_name || match.mapping.artistName.split(" ").slice(1).join(" ") || "";
    const notes = [
      "Imported from Google Calendar.",
      `Original event: ${match.event.summary || "Untitled calendar event"}`,
    ].join("\n");
    await db.prepare(`
      INSERT INTO applications (
        id, created_at, updated_at, status, category, service, service_option,
        preferred_date, preferred_time, first_name, last_name, artist_name,
        email, phone, social_links, notes, google_event_id,
        calendar_sync_status, email_notification_status, decided_at, deposit_status
      ) VALUES (?, ?, ?, 'confirmed', 'calendar', 'Calendar Session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 'not_required', ?, 'not_required')
    `).bind(
      id, match.event.created || now, now, match.range.serviceOption,
      match.range.date, match.range.time, firstName, lastName,
      artist.artist_name || match.mapping.artistName, artist.email, artist.phone || "Not provided",
      artist.social_links || null, notes, match.event.id, now,
    ).run();
    imported.push({ id, eventId: match.event.id, title: match.event.summary, artistName: match.mapping.artistName });
  }

  return json({
    imported, skipped, missingArtists: [...new Set(missingArtists)],
    scannedCount: scan.scannedCount,
  });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
