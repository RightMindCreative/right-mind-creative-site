import { updateCalendarEvent } from "../../_lib/google-calendar.js";
import { sendPaymentConfirmationEmail } from "../../_lib/payment-confirmation-email.js";
import { verifyStripeEvent } from "../../_lib/stripe.js";

const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

const confirmPayment = async (context, session) => {
  const applicationId = session.metadata?.application_id || session.client_reference_id;
  if (!applicationId || session.payment_status !== "paid") return;
  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(applicationId).first();
  if (!application) return;
  if (Number(session.amount_total) !== Number(application.deposit_amount_cents)
      || String(session.currency).toLowerCase() !== "usd") {
    throw new Error("Stripe payment amount did not match the approved deposit.");
  }
  const newlyPaid = application.deposit_status !== "paid";
  if (newlyPaid) {
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
    application.status = "confirmed";
    application.deposit_status = "paid";
    application.deposit_paid_at = paidAt;
    application.deposit_amount_paid_cents = session.amount_total;
  }

  if (newlyPaid && application.google_event_id) {
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

  if (application.payment_confirmation_email_status !== "sent") {
    const claimed = await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET payment_confirmation_email_status = 'sending',
          payment_confirmation_email_error = NULL, updated_at = ?
      WHERE id = ?
        AND payment_confirmation_email_status IN ('not_sent', 'failed')
    `).bind(new Date().toISOString(), application.id).run();
    if (claimed.meta?.changes) {
      const origin = context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin;
      const statusUrl = `${origin}/application-status?token=${encodeURIComponent(application.public_status_token)}`;
      try {
        const message = await sendPaymentConfirmationEmail(context.env, application, statusUrl);
        const sentAt = new Date().toISOString();
        await context.env.APPLICATIONS_DB.prepare(`
          UPDATE applications
          SET payment_confirmation_email_status = 'sent',
              payment_confirmation_email_message_id = ?,
              payment_confirmation_email_sent_at = ?, updated_at = ?
          WHERE id = ?
        `).bind(message.id || null, sentAt, sentAt, application.id).run();
      } catch (error) {
        await context.env.APPLICATIONS_DB.prepare(`
          UPDATE applications
          SET payment_confirmation_email_status = 'failed',
              payment_confirmation_email_error = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          String(error.message || error).slice(0, 1000), new Date().toISOString(), application.id,
        ).run();
        throw error;
      }
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
