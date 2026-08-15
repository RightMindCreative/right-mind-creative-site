import { json } from "../../../../_lib/admin-auth.js";
import {
  CONFIRMED_BOOKING_COLOR_ID,
} from "../../../../_lib/application-notifications.js";
import {
  createCalendarEvent, deleteCalendarEvent, getBusyPeriods, updateCalendarEvent,
} from "../../../../_lib/google-calendar.js";
import { requireSimonService } from "../../../../_lib/simon-service-auth.js";

const clean = (value, length = 200) => String(value || "").trim().slice(0, length);
const activeStatuses = new Set(["approved", "payment_pending", "confirmed"]);
const hashRequest = async (payload) => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const centralParts = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
const localSlot = (date) => {
  const parts = centralParts(date);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const normalizedStoredTime = (value) => {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return "";
  let hour = Number(match[1]);
  if (match[3]) hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
};
const durationMinutes = (option) => {
  const match = clean(option).match(/^(\d+(?:\.\d+)?)\s*hours?$/i);
  if (match) return Math.round(Number(match[1]) * 60);
  if (/day rate|full day/i.test(option || "")) return 720;
  return 0;
};
const optionFor = (minutes) => `${minutes / 60} hours`;
const overlaps = (period, start, end) => (
  new Date(period.start).getTime() < end.getTime()
  && new Date(period.end).getTime() > start.getTime()
);
const withinStudioHours = (start, end) => {
  const slot = localSlot(start);
  const endSlot = localSlot(end);
  if (slot.date !== endSlot.date) return false;
  const probe = new Date(`${slot.date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short",
  }).format(probe);
  if (weekday === "Mon") return false;
  const [hour, minute] = slot.time.split(":").map(Number);
  const opens = weekday === "Sun" ? 13 * 60 : 10 * 60;
  const startMinute = hour * 60 + minute;
  return startMinute >= opens && endSlot.time <= "24:00";
};
const idempotentResponse = async (db, key, requestHash) => {
  const existing = await db.prepare(`
    SELECT request_hash, response_json FROM simon_idempotency WHERE idempotency_key = ?
  `).bind(key).first();
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return json({ error: "That idempotency key was already used for a different request." }, 409);
  }
  return json(JSON.parse(existing.response_json));
};

export async function onRequestPost(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The split request could not be read." }, 400); }

  const preview = payload.preview === true;
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"));
  if (!preview && !idempotencyKey) {
    return json({ error: "An Idempotency-Key header is required." }, 400);
  }
  const requestHash = await hashRequest(payload);
  if (!preview) {
    const duplicate = await idempotentResponse(
      context.env.APPLICATIONS_DB, idempotencyKey, requestHash,
    );
    if (duplicate) return duplicate;
  }

  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(context.params.id).first();
  if (!application) return json({ error: "Booking not found." }, 404);
  if (!activeStatuses.has(application.status) || !application.google_event_id) {
    return json({ error: "Only an active calendar-linked booking can be split." }, 409);
  }

  const firstStart = new Date(payload.firstStartsAt || "");
  const secondStart = new Date(payload.secondStartsAt || "");
  const firstDuration = Number(payload.firstDurationMinutes);
  const secondDuration = Number(payload.secondDurationMinutes);
  const originalDuration = durationMinutes(application.service_option);
  if ([firstStart, secondStart].some((value) => Number.isNaN(value.getTime()))
      || ![firstDuration, secondDuration].every(
        (value) => Number.isInteger(value) && value > 0 && value % 30 === 0,
      )
      || !originalDuration || firstDuration + secondDuration !== originalDuration) {
    return json({ error: "The two segments must be valid half-hour increments totaling the original session." }, 422);
  }
  const originalSlot = {
    date: clean(application.preferred_date, 10),
    time: normalizedStoredTime(application.preferred_time),
  };
  const firstSlot = localSlot(firstStart);
  const secondEnd = new Date(secondStart.getTime() + secondDuration * 60000);
  if (firstSlot.date !== originalSlot.date || firstSlot.time !== originalSlot.time) {
    return json({ error: "The first segment must begin when the original booking begins." }, 422);
  }
  if (secondStart.getTime() <= Date.now() || !withinStudioHours(secondStart, secondEnd)) {
    return json({ error: "The second segment is outside available studio hours." }, 422);
  }
  try {
    const busy = await getBusyPeriods(
      context.env, secondStart.toISOString(), secondEnd.toISOString(),
    );
    if (busy.some((period) => overlaps(period, secondStart, secondEnd))) {
      return json({ error: "The second segment conflicts with another calendar event." }, 409);
    }
  } catch {
    return json({ error: "Live calendar availability could not be verified." }, 503);
  }

  const validated = {
    valid: true,
    firstStartsAt: firstStart.toISOString(),
    firstEndsAt: new Date(firstStart.getTime() + firstDuration * 60000).toISOString(),
    secondStartsAt: secondStart.toISOString(),
    secondEndsAt: secondEnd.toISOString(),
  };
  if (preview) return json(validated);

  const artist = application.artist_name
    || `${application.first_name || ""} ${application.last_name || ""}`.trim();
  const first = localSlot(firstStart);
  const second = localSlot(secondStart);
  const firstEnd = new Date(firstStart.getTime() + firstDuration * 60000);
  const secondId = crypto.randomUUID();
  const now = new Date().toISOString();
  const timeZone = context.env.BOOKING_TIME_ZONE || "America/Chicago";
  let secondEvent;
  try {
    secondEvent = await createCalendarEvent(context.env, {
      summary: `BOOKED · ${application.service} · ${artist}`,
      description: `Split continuation of booking ${application.id}.`,
      colorId: context.env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID,
      transparency: "opaque",
      start: { dateTime: secondStart.toISOString(), timeZone },
      end: { dateTime: secondEnd.toISOString(), timeZone },
    });
    await updateCalendarEvent(context.env, application.google_event_id, {
      start: { dateTime: firstStart.toISOString(), timeZone },
      end: { dateTime: firstEnd.toISOString(), timeZone },
      summary: `BOOKED · ${application.service} · ${artist}`,
      colorId: context.env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID,
      transparency: "opaque",
    });
  } catch (error) {
    if (secondEvent?.id) await deleteCalendarEvent(context.env, secondEvent.id).catch(() => {});
    return json({ error: "The calendar could not apply both split segments." }, 502);
  }

  const response = {
    split: true, originalBookingId: application.id, secondBookingId: secondId, ...validated,
  };
  try {
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications SET service_option = ?, preferred_date = ?, preferred_time = ?,
          calendar_sync_status = 'sent', calendar_sync_error = NULL, updated_at = ? WHERE id = ?
      `).bind(optionFor(firstDuration), first.date, first.time, now, application.id),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO applications (
          id, created_at, updated_at, status, category, service, service_option,
          preferred_date, preferred_time, first_name, last_name, artist_name,
          email, phone, stem_count, social_links, notes, google_event_id,
          stripe_payment_status, calendar_sync_status, email_notification_status,
          decided_at, public_status_token, decision_email_status,
          deposit_amount_cents, deposit_currency, deposit_status,
          payment_confirmation_email_status
        ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'split', 'sent', 'disabled', ?, ?, 'not_sent', 0, 'usd', 'waived', 'not_sent')
      `).bind(
        secondId, now, now, application.category, application.service,
        optionFor(secondDuration), second.date, second.time, application.first_name,
        application.last_name, application.artist_name, application.email,
        application.phone, application.stem_count, application.social_links,
        `Split continuation of booking ${application.id}.`, secondEvent.id, now,
        crypto.randomUUID(),
      ),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_idempotency
          (idempotency_key, request_hash, application_id, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(idempotencyKey, requestHash, application.id, JSON.stringify(response), now),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'booking.split', ?, ?, ?, 'split')
      `).bind(crypto.randomUUID(), now, context.request.headers.get("x-request-id") || "",
        idempotencyKey, application.id),
    ]);
  } catch (error) {
    await deleteCalendarEvent(context.env, secondEvent.id).catch(() => {});
    await updateCalendarEvent(context.env, application.google_event_id, {
      start: { dateTime: firstStart.toISOString(), timeZone },
      end: {
        dateTime: new Date(firstStart.getTime() + originalDuration * 60000).toISOString(),
        timeZone,
      },
    }).catch(() => {});
    return json({ error: "The split was rolled back because the booking records could not be saved." }, 500);
  }
  return json(response);
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
