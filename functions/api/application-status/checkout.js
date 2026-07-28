import { createDepositCheckout, stripeIsConfigured } from "../../_lib/stripe.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const same = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
};

export async function onRequestPost(context) {
  if (!context.env.APPLICATIONS_DB || !stripeIsConfigured(context.env)) {
    return json({ error: "Deposit checkout is not configured yet." }, 503);
  }
  let payload;
  try { payload = await context.request.json(); } catch { return json({ error: "The checkout request could not be read." }, 400); }
  const token = String(payload.token || "");
  const lastFour = String(payload.lastFour || "").replace(/\D/g, "").slice(-4);
  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE public_status_token = ?",
  ).bind(token).first();
  const storedLastFour = String(application?.phone || "").replace(/\D/g, "").slice(-4);
  if (!application || lastFour.length !== 4 || !same(lastFour, storedLastFour)) {
    return json({ error: "We couldn’t verify this application." }, 404);
  }
  if (!["approved", "payment_pending"].includes(application.status)
      || application.deposit_status !== "pending"
      || !application.deposit_amount_cents) {
    return json({ error: application.deposit_status === "paid"
      ? "This deposit has already been paid."
      : "This application is not ready for payment." }, 409);
  }
  try {
    const session = await createDepositCheckout(
      context.env, application, context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin,
    );
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET status = 'payment_pending', stripe_checkout_session_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(session.id, new Date().toISOString(), application.id).run();
    return json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe Checkout creation failed", { applicationId: application.id, error });
    return json({ error: "We couldn’t open secure checkout. Please try again." }, 502);
  }
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
