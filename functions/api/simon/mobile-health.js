import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";
import { calendarIsConfigured } from "../../_lib/google-calendar.js";
import { stripeIsConfigured } from "../../_lib/stripe.js";

// Read-only contract check. No client records, credentials or provider IDs leave this route.
export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  try {
    await context.env.APPLICATIONS_DB.prepare("SELECT 1 AS ready").first();
    return json({
      contract: "rmc-mobile-booking-v1",
      ready: true,
      calendarConfigured: calendarIsConfigured(context.env),
      checkoutConfigured: stripeIsConfigured(context.env),
    });
  } catch {
    return json({ ready: false, error: "Booking storage is temporarily unavailable." }, 503);
  }
}

export function onRequest(context) {
  return context.request.method === "GET" ? onRequestGet(context) : json({ error: "Method not allowed." }, 405);
}
