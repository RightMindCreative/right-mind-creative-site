import { requireAdmin } from "../../_lib/admin-auth.js";
import {
  addApplicationToCalendar,
  CONFIRMED_BOOKING_COLOR_ID,
  DEPOSIT_PENDING_COLOR_ID,
} from "../../_lib/application-notifications.js";
import { deleteCalendarEvent, updateCalendarEvent } from "../../_lib/google-calendar.js";

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

  const application = {
    id: row.id,
    createdAt: row.created_at,
    category: row.category,
    service: row.service,
    serviceOption: row.service_option,
    preferredDate: row.preferred_date,
    preferredTime: row.preferred_time,
    firstName: row.first_name,
    lastName: row.last_name,
    artistName: row.artist_name,
    email: row.email,
    phone: row.phone,
    stemCount: row.stem_count,
    socialLinks: row.social_links,
    notes: row.notes,
    usesCalendar: row.category !== "mixing" && row.service !== "Custom Project",
  };
  const storedFiles = (files.results || []).map((file) => ({
    id: file.id,
    objectKey: file.object_key,
    name: file.original_name,
    type: file.content_type,
    size: file.size_bytes,
  }));

  try {
    if (row.status === "declined") {
      if (row.google_event_id) await deleteCalendarEvent(context.env, row.google_event_id);
      await context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications
        SET updated_at = ?, google_event_id = NULL,
            calendar_sync_status = 'deleted', calendar_sync_error = NULL
        WHERE id = ?
      `).bind(new Date().toISOString(), id).run();
      return json({ id, calendar: { status: "deleted" } });
    }

    let eventId = row.google_event_id;
    let result = { status: "sent", eventId };
    if (!eventId) {
      result = await addApplicationToCalendar(application, storedFiles, context.env);
      eventId = result.eventId;
    }

    if (eventId && ["approved", "payment_pending", "confirmed"].includes(row.status)) {
      const artist = row.artist_name || `${row.first_name} ${row.last_name}`.trim();
      const confirmed = row.status === "confirmed" || row.deposit_status === "paid";
      await updateCalendarEvent(context.env, eventId, {
        summary: `${confirmed ? "BOOKED" : "DEPOSIT PENDING"} · ${row.service} · ${artist}`,
        colorId: confirmed
          ? (context.env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID)
          : (context.env.DEPOSIT_PENDING_CALENDAR_COLOR_ID || DEPOSIT_PENDING_COLOR_ID),
        transparency: confirmed ? "opaque" : "transparent",
      });
    }

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
