const STRIPE_API = "https://api.stripe.com/v1";

export const stripeIsConfigured = (env) => Boolean(env.STRIPE_SECRET_KEY);

export const createDepositCheckout = async (env, application, origin) => {
  const statusUrl = `${origin}/application-status?token=${encodeURIComponent(application.public_status_token)}`;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${statusUrl}&payment=success`,
    cancel_url: `${statusUrl}&payment=cancelled`,
    customer_email: application.email,
    client_reference_id: application.id,
    "metadata[application_id]": application.id,
    "payment_intent_data[metadata][application_id]": application.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(application.deposit_amount_cents),
    "line_items[0][price_data][product_data][name]": `Right Mind Creative · ${application.service} deposit`,
  });
  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Stripe request failed (${response.status}).`);
  return result;
};

export const refundDeposit = async (env, application) => {
  if (!application.stripe_payment_intent_id) throw new Error("This booking does not have a Stripe payment to refund.");
  const response = await fetch(`${STRIPE_API}/refunds`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `application-refund-${application.id}`,
    },
    body: new URLSearchParams({
      payment_intent: application.stripe_payment_intent_id,
      reason: "requested_by_customer",
      "metadata[application_id]": application.id,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Stripe refund failed (${response.status}).`);
  return result;
};

const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
};

export const verifyStripeEvent = async (rawBody, signatureHeader, secret) => {
  if (!signatureHeader || !secret) throw new Error("Stripe webhook verification is not configured.");
  const values = signatureHeader.split(",").map((part) => part.split("="));
  const timestamp = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Error("Stripe webhook signature is invalid or expired.");
  }
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = hex(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
  if (!signatures.some((signature) => constantTimeEqual(signature, digest))) {
    throw new Error("Stripe webhook signature does not match.");
  }
  return JSON.parse(rawBody);
};
