import assert from "node:assert/strict";
import test from "node:test";

import { matchingServices, serviceById } from "../functions/_lib/service-catalog.js";
import { addApplicationToCalendar } from "../functions/_lib/application-notifications.js";
import { decisionCopyFor } from "../functions/_lib/decision-email.js";
import { requireSimonService } from "../functions/_lib/simon-service-auth.js";
import {
  SIMON_APPLICATION_STATUS, SIMON_PAYMENT_STATUS, simonPaymentIsConfigured,
} from "../functions/api/simon/bookings.js";
import {
  applicationApprovedEvent,
  bookingConfirmedEvent,
} from "../functions/_lib/simon-notifications.js";

const context = (authorization = "", overrides = {}) => ({
  request: new Request("https://preview.example.pages.dev/api/simon/services", {
    headers: authorization ? { authorization } : {},
  }),
  env: {
    APPLICATIONS_DB: {},
    SIMON_SERVICE_TOKEN: "test-service-token",
    ...overrides,
  },
});

test("service aliases resolve to one website-owned ID", () => {
  assert.deepEqual(matchingServices("vocals").map((item) => item.id), ["vocal-recording"]);
  assert.equal(serviceById("music-production").name, "Music Production");
});

test("missing and incorrect service credentials are rejected", async () => {
  assert.equal(requireSimonService(context()).status, 401);
  assert.equal(requireSimonService(context("Bearer wrong-token")).status, 401);
});

test("correct scoped service credential is accepted", () => {
  assert.equal(requireSimonService(context("Bearer test-service-token")), null);
});

test("unconfigured service boundary fails closed", () => {
  const response = requireSimonService(context("Bearer test-service-token", {
    SIMON_SERVICE_TOKEN: "",
  }));
  assert.equal(response.status, 503);
});

test("owner-confirmed Simon requests create approved applications", () => {
  assert.equal(SIMON_APPLICATION_STATUS, "approved");
  assert.equal(SIMON_PAYMENT_STATUS, "pending");
});

test("Simon deposit handoff requires email, Stripe, and verified webhooks", () => {
  const configured = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "service@example.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "private-key",
    GOOGLE_EMAIL_IMPERSONATED_USER: "welcome@example.com",
    STRIPE_SECRET_KEY: "stripe-key",
    STRIPE_WEBHOOK_SECRET: "webhook-secret",
  };
  assert.equal(simonPaymentIsConfigured(configured), true);
  assert.equal(simonPaymentIsConfigured({ ...configured, STRIPE_WEBHOOK_SECRET: "" }), false);
  assert.match(decisionCopyFor("approved").body, /deposit/i);
  assert.match(decisionCopyFor("approved").body, /Stripe/i);
});

test("non-calendar application types never create calendar events", async () => {
  const result = await addApplicationToCalendar({ usesCalendar: false }, [], {});
  assert.deepEqual(result, { status: "not_required" });
});

test("approved applications emit a minimal contact event", () => {
  const event = applicationApprovedEvent({
    id: "app-1", first_name: "Jordan", last_name: "Lee",
    artist_name: "J Lee", email: "jordan@example.com", phone: "+14025550100",
  });
  assert.equal(event.type, "application.approved");
  assert.equal(event.id, "application-approved:app-1");
  assert.deepEqual(event.application, {
    id: "app-1", firstName: "Jordan", lastName: "Lee",
    artistName: "J Lee", email: "jordan@example.com", phone: "+14025550100",
  });
});

test("confirmed bookings emit an idempotent contact event", () => {
  const event = bookingConfirmedEvent({
    id: "booking-1", firstName: "Avery", lastName: "Jones",
    artistName: "AJ", email: "avery@example.com", phone: "+14025550101",
  });
  assert.equal(event.type, "booking.confirmed");
  assert.equal(event.id, "booking-confirmed:booking-1");
  assert.equal(event.application.email, "avery@example.com");
});
