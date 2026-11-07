import { deleteCalendarEvent } from "./google-calendar.js";
import { createDepositCheckout, expireDepositCheckout, stripeIsConfigured } from "./stripe.js";
import { notifySimonOfCancellation } from "./simon-notifications.js";

export const normalizedEmail = (value) => String(value || "").trim().toLowerCase();
export const normalizedPhone = (value) => String(value || "").replace(/\D/g, "").slice(-10);

export const applicationMatchesIdentity = (application, identity) => {
  const email = normalizedEmail(identity?.email);
  const phone = normalizedPhone(identity?.phone);
  return Boolean(
    (email && normalizedEmail(application?.email) === email)
    || (phone && normalizedPhone(application?.phone) === phone)
  );
};

const startDate = (date, time) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const match = String(time || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) hour = (hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  if (hour > 23 || minute > 59) return null;
  const probe = new Date(`${date}T12:00:00Z`);
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT-06:00";
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${zone.replace("GMT", "")}`);
};

const durationMinutes = (option) => {
  const match = String(option || "").match(/^(\d+)\s*hours?$/i);
  if (match) return Number(match[1]) * 60;
  return /full day|day rate/i.test(String(option || "")) ? 720 : 60;
};

export const clientApplicationSummary = (row) => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  status: row.status,
  category: row.category,
  serviceName: row.service,
  serviceOption: row.service_option || "",
  startsAt: startDate(row.preferred_date, row.preferred_time)?.toISOString() || null,
  durationMinutes: durationMinutes(row.service_option),
  artistName: row.artist_name || "",
  notes: row.notes || "",
  depositAmountCents: row.deposit_amount_cents,
  depositCurrency: row.deposit_currency || "usd",
  depositStatus: row.deposit_status || "not_required",
  depositPaidAt: row.deposit_paid_at,
});

export async function cancelClientApplication(context, application) {
  if (application.status === "cancelled") {
    return { application: clientApplicationSummary(application), duplicate: true };
  }
  if (!["new", "reviewing", "approved", "payment_pending"].includes(application.status)) {
    throw new Response(JSON.stringify({ error: "This application can no longer be cancelled in the app." }), {
      status: 409, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (application.deposit_status === "paid") {
    throw new Response(JSON.stringify({ error: "Contact the studio to change a deposit-paid booking." }), {
      status: 409, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (application.stripe_checkout_session_id && stripeIsConfigured(context.env)) {
    await expireDepositCheckout(context.env, application.stripe_checkout_session_id).catch((error) => {
      console.error("Stripe Checkout expiration failed", { applicationId: application.id, error });
    });
  }

  const now = new Date().toISOString();
  await context.env.APPLICATIONS_DB.batch([
    context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET status = 'cancelled', deposit_status = 'cancelled',
          stripe_payment_status = 'cancelled', updated_at = ?
      WHERE id = ?
    `).bind(now, application.id),
    context.env.APPLICATIONS_DB.prepare(`
      UPDATE session_assignments SET state = 'cancelled', updated_at = ?
      WHERE application_id = ? AND state NOT IN ('declined', 'cancelled')
    `).bind(now, application.id),
  ]);

  try {
    if (application.google_event_id) {
      await deleteCalendarEvent(context.env, application.google_event_id);
    }
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET google_event_id = NULL, calendar_sync_status = 'deleted',
        calendar_sync_error = NULL WHERE id = ?
    `).bind(application.id).run();
  } catch (error) {
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = ? WHERE id = ?
    `).bind(String(error.message || error).slice(0, 500), application.id).run();
  }

  const cancelled = {
    ...application, status: "cancelled", deposit_status: "cancelled", updated_at: now,
  };
  context.waitUntil(notifySimonOfCancellation(cancelled, context.env));
  return { application: clientApplicationSummary(cancelled) };
}

export async function checkoutForClientApplication(context, application, idempotencyKey) {
  if (!stripeIsConfigured(context.env)) {
    throw new Response(JSON.stringify({ error: "Deposit checkout is not configured yet." }), {
      status: 503, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (!["approved", "payment_pending"].includes(application.status)
      || application.deposit_status !== "pending"
      || !application.deposit_amount_cents) {
    throw new Response(JSON.stringify({
      error: application.deposit_status === "paid"
        ? "This deposit has already been paid."
        : "This application is not ready for payment.",
    }), { status: 409, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const session = await createDepositCheckout(
    context.env, application,
    context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin,
    idempotencyKey,
  );
  await context.env.APPLICATIONS_DB.prepare(`
    UPDATE applications SET status = 'payment_pending',
      stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?
  `).bind(session.id, new Date().toISOString(), application.id).run();
  return { checkoutUrl: session.url };
}
