import { json, requireAdmin } from "../../../../_lib/admin-auth.js";
import { buildApplicationEvent, calendarApplicationFromRow, CONFIRMED_BOOKING_COLOR_ID } from "../../../../_lib/application-notifications.js";
import { deleteCalendarEvent, updateCalendarEvent } from "../../../../_lib/google-calendar.js";
import { refundDeposit, stripeIsConfigured } from "../../../../_lib/stripe.js";
import { notifySimonOfCancellation, notifySimonOfReschedule } from "../../../../_lib/simon-notifications.js";

const manageableStatuses = new Set(["approved", "payment_pending", "confirmed"]);
const durationHours = (option) => {
  const match = String(option || "").match(/^(\d+)\s*hours?$/i);
  if (match) return Number(match[1]);
  if (/day rate|full day/i.test(option || "")) return 12;
  return 1;
};
const parseTime = (value) => {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
};

export async function onRequestPost(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  let payload;
  try { payload = await context.request.json(); } catch { return json({ error: "The booking update could not be read." }, 400); }
  const action = String(payload.action || "");
  if (!["cancel", "refund", "reschedule"].includes(action)) return json({ error: "Choose cancel, refund, or reschedule." }, 422);

  const db = context.env.APPLICATIONS_DB;
  const application = await db.prepare("SELECT * FROM applications WHERE id = ?").bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);
  if (!manageableStatuses.has(application.status)) return json({ error: "Only approved or confirmed bookings can be changed." }, 409);
  const paid = application.deposit_status === "paid";

  if (action === "reschedule") {
    if (!paid) return json({ error: "Only deposit-paid bookings can be rescheduled here." }, 409);
    const date = String(payload.date || "");
    const time = String(payload.time || "");
    const parsed = parseTime(time);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : null;
    if (!day || Number.isNaN(day.getTime()) || !parsed) return json({ error: "Choose a valid new date and time." }, 422);
    if (parsed.minute !== 0) return json({ error: "Session start times use one-hour increments." }, 422);
    if (new Date(`${date}T${String(parsed.hour).padStart(2, "0")}:00:00`).getTime() <= Date.now()) return json({ error: "Choose a future session time." }, 422);
    if (day.getDay() === 1) return json({ error: "The studio is closed on Mondays." }, 422);
    if (day.getDay() === 0 && parsed.hour < 13) return json({ error: "Sunday sessions cannot begin before 1:00 PM." }, 422);
    if (parsed.hour + parsed.minute / 60 + durationHours(application.service_option) > 24) return json({ error: "The session cannot extend past midnight." }, 422);
    if (!application.google_event_id) return json({ error: "This booking does not have a linked Google Calendar event." }, 409);

    const updated = { ...application, preferred_date: date, preferred_time: time };
    const calendarApplication = calendarApplicationFromRow(updated);
    const event = buildApplicationEvent(calendarApplication, [], context.env);
    const artist = application.artist_name || `${application.first_name || ""} ${application.last_name || ""}`.trim();
    await updateCalendarEvent(context.env, application.google_event_id, {
      start: event.start, end: event.end,
      summary: `BOOKED · ${application.service} · ${artist}`,
      colorId: context.env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID,
      transparency: "opaque",
    });
    const now = new Date().toISOString();
    await db.prepare(`UPDATE applications SET preferred_date = ?, preferred_time = ?, calendar_sync_status = 'sent', calendar_sync_error = NULL, updated_at = ? WHERE id = ?`)
      .bind(date, time, now, application.id).run();
    context.waitUntil(notifySimonOfReschedule({
      ...updated, updated_at: now,
    }, context.env));
    return json({ application: { ...updated, updated_at: now }, action });
  }

  if (action === "refund") {
    if (!paid) return json({ error: "No paid deposit is available to refund." }, 409);
    if (!stripeIsConfigured(context.env)) return json({ error: "Stripe refunds are not configured." }, 503);
    await refundDeposit(context.env, application);
  } else if (paid) {
    return json({ error: "A paid booking must be rescheduled or refunded." }, 409);
  }

  const now = new Date().toISOString();
  const depositStatus = action === "refund" ? "refunded" : "cancelled";
  await db.prepare(`UPDATE applications SET status = 'cancelled', deposit_status = ?, stripe_payment_status = ?, updated_at = ? WHERE id = ?`)
    .bind(depositStatus, depositStatus, now, application.id).run();
  await db.prepare(`UPDATE session_assignments SET state = 'cancelled', updated_at = ? WHERE application_id = ? AND state NOT IN ('declined', 'cancelled')`)
    .bind(now, application.id).run();
  try {
    if (application.google_event_id) await deleteCalendarEvent(context.env, application.google_event_id);
    await db.prepare(`UPDATE applications SET google_event_id = NULL, calendar_sync_status = 'deleted', calendar_sync_error = NULL WHERE id = ?`).bind(application.id).run();
  } catch (error) {
    await db.prepare(`UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = ? WHERE id = ?`)
      .bind(String(error.message || error).slice(0, 500), application.id).run();
  }
  context.waitUntil(notifySimonOfCancellation({
    ...application,
    status: "cancelled",
    deposit_status: depositStatus,
    updated_at: now,
  }, context.env));
  return json({ application: { ...application, status: "cancelled", deposit_status: depositStatus, updated_at: now }, action });
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
