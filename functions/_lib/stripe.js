const STRIPE_API = "https://api.stripe.com/v1";

export const stripeIsConfigured = (env) => Boolean(env.STRIPE_SECRET_KEY);

const stripeModePolicy = (env, livemode) => {
  const environment = env.SIMON_V3_ENVIRONMENT === "production" ? "production" : "staging";
  const mode = livemode === true ? "live" : "test";
  const ready = (environment === "production" && livemode === true)
    || (environment === "staging" && livemode === false);
  return { environment, mode, ready };
};

export const getStripeHealth = async (env) => {
  if (!stripeIsConfigured(env)) return { state: "not_configured", mode: null };
  const response = await fetch(`${STRIPE_API}/balance`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Stripe health request failed (${response.status}).`);
  const policy = stripeModePolicy(env, result.livemode === true);
  return { state: policy.ready ? "ready" : "unsafe_mode", mode: policy.mode };
};

const stripeRequest = async (env, path, { method = "GET", body, idempotencyKey } = {}) => {
  if (!stripeIsConfigured(env)) throw new Error("Stripe is not configured.");
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Stripe request failed (${response.status}).`);
  const policy = stripeModePolicy(env, result.livemode === true);
  if (!policy.ready) throw new Error(`Simon V3 ${policy.environment} refuses ${policy.mode}-mode Stripe objects.`);
  return result;
};

export const createSimonPaymentCheckout = async (env, input) => stripeRequest(
  env,
  "/checkout/sessions",
  {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.bookingId,
      "metadata[simon_v3_booking_id]": input.bookingId,
      "metadata[simon_v3_payment_link_id]": input.paymentLinkId,
      "payment_intent_data[metadata][simon_v3_booking_id]": input.bookingId,
      "payment_intent_data[metadata][simon_v3_payment_link_id]": input.paymentLinkId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": input.description,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      ...(input.expiresAt ? { expires_at: String(input.expiresAt) } : {}),
    },
  },
);

export const getSimonCheckout = async (env, sessionId) => stripeRequest(
  env, `/checkout/sessions/${encodeURIComponent(sessionId)}`,
);

export const expireSimonCheckout = async (env, sessionId, idempotencyKey) => stripeRequest(
  env, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
  { method: "POST", idempotencyKey },
);

export const createSimonRefund = async (env, input) => stripeRequest(
  env,
  "/refunds",
  {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      payment_intent: input.paymentIntentId,
      amount: String(input.amountMinor),
      reason: "requested_by_customer",
      "metadata[simon_v3_booking_id]": input.bookingId,
    },
  },
);

export const getSimonRefund = async (env, refundId) => stripeRequest(
  env, `/refunds/${encodeURIComponent(refundId)}`,
);

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
