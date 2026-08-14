import { json } from "../../_lib/admin-auth.js";
import {
  addApplicationToCalendar, DEPOSIT_PENDING_COLOR_ID,
} from "../../_lib/application-notifications.js";
import { decisionEmailIsConfigured, sendDecisionEmail } from "../../_lib/decision-email.js";
import { depositForApplication } from "../../_lib/deposits.js";
import { updateCalendarEvent } from "../../_lib/google-calendar.js";
import { stripeIsConfigured } from "../../_lib/stripe.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";
import { serviceById } from "../../_lib/service-catalog.js";
import { onRequestGet as scopedAvailability } from "./availability.js";
import { notifySimonOfBooking } from "../../_lib/simon-notifications.js";

const clean = (value, length) => String(value || "").trim().slice(0, length);
const escapedLike = (value) => clean(value, 200).replace(/[\\%_]/g, "\\$&");
export const SIMON_APPLICATION_STATUS = "approved";
export const SIMON_PAYMENT_STATUS = "pending";
export const simonPaymentIsConfigured = (env) => Boolean(
  decisionEmailIsConfigured(env)
  && stripeIsConfigured(env)
  && env.STRIPE_WEBHOOK_SECRET
);

const hashRequest = async (payload) => {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const centralParts = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: true,
}).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});

const responseFor = (application, client, service, startsAt, endsAt) => ({
  confirmed: true,
  booking: {
    id: application.id,
    client,
    service: { id: service.id, name: service.name },
    startsAt,
    endsAt,
    status: application.status,
    paymentStatus: application.paymentStatus,
    notificationStatus: application.notificationStatus,
  },
});

export const bookingSummary = (row) => ({
  id: String(row.id || ""),
  artistName: String(row.artist_name || `${row.first_name || ""} ${row.last_name || ""}`.trim()),
  serviceName: String(row.service || ""),
  serviceOption: String(row.service_option || ""),
  preferredDate: String(row.preferred_date || ""),
  preferredTime: String(row.preferred_time || ""),
  status: String(row.status || ""),
  depositStatus: String(row.deposit_status || ""),
  calendarLinked: Boolean(row.google_event_id),
});

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const url = new URL(context.request.url);
  const artist = clean(url.searchParams.get("artist"), 200);
  const date = clean(url.searchParams.get("date"), 10);
  if (!artist) return json({ error: "An artist name is required." }, 400);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "Enter a valid existing booking date." }, 400);
  }
  const pattern = `%${escapedLike(artist)}%`;
  const dateClause = date ? "AND preferred_date = ?" : "";
  const statement = context.env.APPLICATIONS_DB.prepare(`
    SELECT id, first_name, last_name, artist_name, service, service_option,
      preferred_date, preferred_time, status, deposit_status, google_event_id
    FROM applications
    WHERE status IN ('approved', 'payment_pending', 'confirmed')
      AND (artist_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
          LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ${dateClause}
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 10
  `);
  const result = date
    ? await statement.bind(pattern, pattern, date).all()
    : await statement.bind(pattern, pattern).all();
  return json({ bookings: (result.results || []).map(bookingSummary) });
}

const existingIdempotentResponse = async (db, key, requestHash) => {
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
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"), 200);
  if (!idempotencyKey) return json({ error: "An Idempotency-Key header is required." }, 400);

  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The booking request could not be read." }, 400); }
  const requestHash = await hashRequest(payload);
  const duplicate = await existingIdempotentResponse(
    context.env.APPLICATIONS_DB, idempotencyKey, requestHash,
  );
  if (duplicate) return duplicate;

  const service = serviceById(clean(payload.serviceId, 100));
  const durationMinutes = Number(payload.durationMinutes);
  const startsAt = new Date(payload.startsAt || "");
  const client = {
    id: clean(payload.client?.id, 200),
    name: clean(payload.client?.name, 200),
    phone: clean(payload.client?.phone, 60),
    email: clean(payload.client?.email, 254).toLowerCase(),
  };
  if (!service || !service.durationOptions.includes(durationMinutes)
      || Number.isNaN(startsAt.getTime()) || !client.name || !client.phone
      || !/^\S+@\S+\.\S+$/.test(client.email)) {
    return json({ error: "The booking request is incomplete or invalid." }, 422);
  }
  if (!simonPaymentIsConfigured(context.env)) {
    return json({ error: "Deposit email or Stripe Checkout is not configured." }, 503);
  }

  const availabilityUrl = new URL("/api/simon/availability", context.request.url);
  availabilityUrl.searchParams.set("serviceId", service.id);
  availabilityUrl.searchParams.set("startsAfter", payload.startsAt);
  availabilityUrl.searchParams.set("endsBefore", new Date(startsAt.getTime() + durationMinutes * 60000).toISOString());
  availabilityUrl.searchParams.set("durationMinutes", String(durationMinutes));
  const availabilityResponse = await scopedAvailability({
    ...context, request: new Request(availabilityUrl, { headers: context.request.headers }),
  });
  const availability = await availabilityResponse.json();
  if (!availabilityResponse.ok) return json(availability, availabilityResponse.status);
  if (!availability.slots?.length) return json({ error: "The requested slot is unavailable." }, 409);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const statusToken = crypto.randomUUID();
  const nameParts = client.name.split(/\s+/);
  const firstName = nameParts.shift() || client.name;
  const lastName = nameParts.join(" ") || "Artist";
  const local = centralParts(startsAt);
  const preferredDate = `${local.year}-${local.month}-${local.day}`;
  const preferredTime = `${local.hour}:${local.minute} ${local.dayPeriod}`;
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60000).toISOString();
  const application = {
    id, createdAt: now, category: service.category, service: service.name,
    serviceOption: `${durationMinutes / 60} hours`, preferredDate, preferredTime,
    firstName, lastName, artistName: client.name, email: client.email,
    phone: client.phone, stemCount: "", socialLinks: "",
    notes: "Created and owner-approved by Simon through the scoped service API.", usesCalendar: true,
  };
  let depositAmount;
  try {
    depositAmount = depositForApplication(application);
  } catch (error) {
    return json({ error: error.message }, 422);
  }
  const result = responseFor(
    {
      id, status: SIMON_APPLICATION_STATUS, paymentStatus: SIMON_PAYMENT_STATUS,
      notificationStatus: "pending",
    },
    client, service, payload.startsAt, endsAt,
  );

  try {
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO applications (
          id, created_at, updated_at, status, category, service, service_option,
          preferred_date, preferred_time, first_name, last_name, artist_name,
          email, phone, notes, email_notification_status, public_status_token,
          decided_at, decision_email_status, deposit_amount_cents,
          deposit_currency, deposit_status
        ) VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disabled', ?,
          ?, 'sending', ?, 'usd', 'pending')
      `).bind(
        id, now, now, service.category, service.name, application.serviceOption,
        preferredDate, preferredTime, firstName, lastName, client.name,
        client.email, client.phone, application.notes, statusToken,
        now, depositAmount,
      ),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_idempotency
          (idempotency_key, request_hash, application_id, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(idempotencyKey, requestHash, id, JSON.stringify(result), now),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'booking.create', ?, ?, ?, 'approved')
      `).bind(crypto.randomUUID(), now, context.request.headers.get("x-request-id") || "", idempotencyKey, id),
    ]);
  } catch (error) {
    const raced = await existingIdempotentResponse(
      context.env.APPLICATIONS_DB, idempotencyKey, requestHash,
    );
    if (raced) return raced;
    console.error("Simon booking request failed", { applicationId: id, error });
    return json({ error: "The booking request could not be created." }, 500);
  }

  context.waitUntil(notifySimonOfBooking(application, context.env));

  try {
    const calendar = await addApplicationToCalendar(application, [], context.env);
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET google_event_id = ?, calendar_sync_status = ?,
        calendar_sync_error = NULL, updated_at = ? WHERE id = ?
    `).bind(calendar.eventId || null, calendar.status, new Date().toISOString(), id).run();
    if (calendar.eventId) {
      await updateCalendarEvent(context.env, calendar.eventId, {
        summary: `DEPOSIT PENDING · ${service.name} · ${client.name}`,
        colorId: context.env.DEPOSIT_PENDING_CALENDAR_COLOR_ID || DEPOSIT_PENDING_COLOR_ID,
        eventLabelName: "Citron",
        transparency: "transparent",
      });
    }
  } catch (error) {
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = ?,
        updated_at = ? WHERE id = ?
    `).bind(String(error.message || error).slice(0, 500), new Date().toISOString(), id).run();
    console.error("Simon booking calendar sync failed", { applicationId: id, error });
  }

  const statusUrl = `${context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin}`
    + `/application-status?token=${encodeURIComponent(statusToken)}`;
  try {
    const message = await sendDecisionEmail(context.env, application, "approved", statusUrl);
    result.booking.notificationStatus = "sent";
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications
        SET decision_email_status = 'sent', decision_email_message_id = ?, updated_at = ?
        WHERE id = ?
      `).bind(message.id || null, new Date().toISOString(), id),
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE simon_idempotency SET response_json = ? WHERE idempotency_key = ?
      `).bind(JSON.stringify(result), idempotencyKey),
    ]);
  } catch (error) {
    result.booking.notificationStatus = "failed";
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications
        SET decision_email_status = 'failed', decision_email_error = ?, updated_at = ?
        WHERE id = ?
      `).bind(String(error.message || error).slice(0, 1000), new Date().toISOString(), id),
      context.env.APPLICATIONS_DB.prepare(`
        UPDATE simon_idempotency SET response_json = ? WHERE idempotency_key = ?
      `).bind(JSON.stringify(result), idempotencyKey),
    ]);
    console.error("Simon deposit email failed", { applicationId: id, error });
  }

  return json(result, 201);
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
