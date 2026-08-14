import { json } from "../../../_lib/admin-auth.js";
import {
  buildApplicationEvent, calendarApplicationFromRow, CONFIRMED_BOOKING_COLOR_ID,
} from "../../../_lib/application-notifications.js";
import { updateCalendarEvent } from "../../../_lib/google-calendar.js";
import { requireSimonService } from "../../../_lib/simon-service-auth.js";
import { matchingServices, serviceById } from "../../../_lib/service-catalog.js";
import { onRequestGet as scopedAvailability } from "../availability.js";
import { bookingSummary } from "../bookings.js";

const clean = (value, length = 200) => String(value || "").trim().slice(0, length);
const hashRequest = async (payload) => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const existingResponse = async (db, key, requestHash) => {
  const existing = await db.prepare(`
    SELECT request_hash, response_json FROM simon_idempotency WHERE idempotency_key = ?
  `).bind(key).first();
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return json({ error: "That idempotency key was already used for a different request." }, 409);
  }
  return json(JSON.parse(existing.response_json));
};
const centralParts = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: true,
}).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
const resolveService = (application, requestedId) => {
  if (requestedId) return serviceById(requestedId);
  const matches = matchingServices(application.service);
  return matches.length === 1 ? matches[0] : null;
};

export async function onRequestPatch(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"));
  if (!idempotencyKey) return json({ error: "An Idempotency-Key header is required." }, 400);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The reschedule request could not be read." }, 400); }
  const requestHash = await hashRequest(payload);
  const duplicate = await existingResponse(context.env.APPLICATIONS_DB, idempotencyKey, requestHash);
  if (duplicate) return duplicate;

  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(context.params.id).first();
  if (!application) return json({ error: "Booking not found." }, 404);
  if (!["approved", "payment_pending", "confirmed"].includes(application.status)) {
    return json({ error: "Only an active booking can be rescheduled." }, 409);
  }
  if (!application.google_event_id) {
    return json({ error: "This booking does not have a linked calendar event." }, 409);
  }

  const startsAt = new Date(payload.startsAt || "");
  const durationMinutes = Number(payload.durationMinutes);
  const service = resolveService(application, clean(payload.serviceId));
  if (!service || Number.isNaN(startsAt.getTime()) || !Number.isInteger(durationMinutes)
      || !service.durationOptions.includes(durationMinutes)) {
    return json({ error: "Enter a valid service, start, and duration." }, 422);
  }
  const availabilityUrl = new URL("/api/simon/availability", context.request.url);
  availabilityUrl.searchParams.set("serviceId", service.id);
  availabilityUrl.searchParams.set("startsAfter", payload.startsAt);
  availabilityUrl.searchParams.set(
    "endsBefore", new Date(startsAt.getTime() + durationMinutes * 60000).toISOString(),
  );
  availabilityUrl.searchParams.set("durationMinutes", String(durationMinutes));
  const availabilityResponse = await scopedAvailability({
    ...context, request: new Request(availabilityUrl, { headers: context.request.headers }),
  });
  const availability = await availabilityResponse.json();
  if (!availabilityResponse.ok) return json(availability, availabilityResponse.status);
  if (!availability.slots?.length) return json({ error: "The requested slot is unavailable." }, 409);

  const local = centralParts(startsAt);
  const preferredDate = `${local.year}-${local.month}-${local.day}`;
  const preferredTime = `${local.hour}:${local.minute} ${local.dayPeriod}`;
  const serviceOption = `${durationMinutes / 60} hours`;
  const updated = {
    ...application, service: service.name, category: service.category,
    service_option: serviceOption, preferred_date: preferredDate, preferred_time: preferredTime,
  };
  const event = buildApplicationEvent(calendarApplicationFromRow(updated), [], context.env);
  const artist = application.artist_name
    || `${application.first_name || ""} ${application.last_name || ""}`.trim();
  try {
    await updateCalendarEvent(context.env, application.google_event_id, {
      start: event.start, end: event.end,
      summary: `BOOKED · ${service.name} · ${artist}`,
      colorId: context.env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID,
      transparency: "opaque",
    });
  } catch (error) {
    return json({ error: "The linked calendar event could not be rescheduled." }, 502);
  }

  const now = new Date().toISOString();
  const response = {
    rescheduled: true,
    booking: bookingSummary({ ...updated, updated_at: now }),
    startsAt: payload.startsAt,
    endsAt: new Date(startsAt.getTime() + durationMinutes * 60000).toISOString(),
    serviceId: service.id,
    durationMinutes,
  };
  try {
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications SET service = ?, category = ?, service_option = ?,
          preferred_date = ?, preferred_time = ?, calendar_sync_status = 'sent',
          calendar_sync_error = NULL, updated_at = ? WHERE id = ?
      `).bind(service.name, service.category, serviceOption, preferredDate,
        preferredTime, now, application.id),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_idempotency
          (idempotency_key, request_hash, application_id, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(idempotencyKey, requestHash, application.id, JSON.stringify(response), now),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'booking.reschedule', ?, ?, ?, 'rescheduled')
      `).bind(crypto.randomUUID(), now, context.request.headers.get("x-request-id") || "",
        idempotencyKey, application.id),
    ]);
  } catch (error) {
    return json({ error: "The calendar changed, but the booking record needs reconciliation." }, 500);
  }
  return json(response);
}

export function onRequest(context) {
  if (context.request.method === "PATCH") return onRequestPatch(context);
  return json({ error: "Method not allowed." }, 405);
}
