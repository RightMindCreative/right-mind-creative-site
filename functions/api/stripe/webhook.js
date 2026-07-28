import { updateCalendarEvent } from "../../_lib/google-calendar.js";
import { verifyStripeEvent } from "../../_lib/stripe.js";

const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

const confirmPayment = async (context, session) => {
  const applicationId = session.metadata?.application_id || session.client_reference_id;
  if (!applicationId || session.payment_status !== "paid") return;
  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(applicationId).first();
  if (!application || application.deposit_status === "paid") return;
  if (Number(session.amount_total) !== Number(application.deposit_amount_cents)
      || String(session.currency).toLowerCase() !== "usd") {
    throw new Error("Stripe payment amount did not match the approved deposit.");
  }
  const paidAt = new Date().toISOString();
  await context.env.APPLICATIONS_DB.prepare(`
    UPDATE applications
    SET status = 'confirmed', deposit_status = 'paid', deposit_paid_at = ?,
        deposit_amount_paid_cents = ?, stripe_checkout_session_id = ?,
        stripe_payment_intent_id = ?, stripe_payment_status = 'paid', updated_at = ?
    WHERE id = ? AND deposit_status != 'paid'
  `).bind(
    paidAt, session.amount_total, session.id, session.payment_intent || null, paidAt, application.id,
  ).run();

  if (application.google_event_id) {
    try {
      const artist = application.artist_name || `${application.first_name} ${application.last_name}`.trim();
      await updateCalendarEvent(context.env, application.google_event_id, {
        summary: `BOOKED · ${application.service} · ${artist}`,
        colorId: context.env.BOOKING_CALENDAR_COLOR_ID || "10",
        transparency: "opaque",
      });
    } catch (error) {
      console.error("Paid booking calendar update failed", { applicationId, error });
    }
  }
};

export async function onRequestPost(context) {
  const rawBody = await context.request.text();
  let event;
  try {
    event = await verifyStripeEvent(
      rawBody, context.request.headers.get("stripe-signature"), context.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    return text(error.message, 400);
  }
  try {
    if (event.type === "checkout.session.completed"
        || event.type === "checkout.session.async_payment_succeeded") {
      await confirmPayment(context, event.data.object);
    }
    return text("ok");
  } catch (error) {
    console.error("Stripe webhook processing failed", { eventId: event.id, error });
    return text("Webhook processing failed.", 500);
  }
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return text("Method not allowed.", 405);
}
