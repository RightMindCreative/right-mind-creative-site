import assert from "node:assert/strict";
import test from "node:test";

import { matchingServices, serviceById } from "../functions/_lib/service-catalog.js";
import { addApplicationToCalendar } from "../functions/_lib/application-notifications.js";
import { decisionCopyFor } from "../functions/_lib/decision-email.js";
import { requireSimonService } from "../functions/_lib/simon-service-auth.js";
import {
  bookingSummary, SIMON_APPLICATION_STATUS, SIMON_PAYMENT_STATUS, simonPaymentIsConfigured,
} from "../functions/api/simon/bookings.js";
import { normalizedPhone } from "../functions/api/simon/artists.js";
import {
  applicationApprovedEvent,
  applicationCancelledEvent,
  applicationReviewedEvent,
  bookingRescheduledEvent,
  bookingConfirmedEvent,
  engineerAssignmentRespondedEvent,
} from "../functions/_lib/simon-notifications.js";
import {
  onRequestPost as approveApplication,
  SIMON_WAIVE_DECISION,
} from "../functions/api/simon/applications/[id]/decision.js";
import { onRequestPost as splitBooking } from "../functions/api/simon/bookings/[id]/split.js";
import { onRequestPost as rollbackWaiver } from "../functions/api/simon/applications/[id]/rollback-waiver.js";

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

test("artist authorization normalizes phone numbers to ten digits", () => {
  assert.equal(normalizedPhone("+1 (402) 555-0100"), "4025550100");
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

test("Simon booking lookup exposes only the scoped reschedule summary", () => {
  assert.deepEqual(bookingSummary({
    id: "booking-1", artist_name: "Doolie", service: "Vocal Recording",
    service_option: "2 hours", preferred_date: "2026-08-12",
    preferred_time: "4:00 PM", status: "confirmed", deposit_status: "paid",
    google_event_id: "private-calendar-id",
  }), {
    id: "booking-1", artistName: "Doolie", serviceName: "Vocal Recording",
    serviceOption: "2 hours", preferredDate: "2026-08-12",
    preferredTime: "4:00 PM", status: "confirmed", depositStatus: "paid",
    assignmentId: "", assignmentState: "", engineerName: "",
    calendarLinked: true,
  });
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

test("engineer responses emit idempotent owner-notification events", () => {
  const event = engineerAssignmentRespondedEvent({
    id: "assignment-1", employee_name: "Jake Kaiser", state: "declined",
    response_note: "Unavailable",
  }, {
    id: "app-1", artist_name: "Jordan", service: "Vocal Recording",
    preferred_date: "2026-08-15", preferred_time: "2:00 PM",
  }, { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });
  assert.equal(event.id, "engineer-assignment-responded:assignment-1:declined");
  assert.equal(event.type, "engineer.assignment_responded");
  assert.equal(event.assignment.status, "declined");
  assert.equal(event.assignment.reviewUrl, "https://www.rightmindcreative.co/admin?application=app-1");
});

test("Simon application approval is limited to explicit deposit waivers", async () => {
  assert.deepEqual(SIMON_WAIVE_DECISION, {
    decision: "approved", waiveDeposit: true,
    resultingStatus: "confirmed", depositStatus: "waived",
  });
  assert.match(decisionCopyFor("approved", { depositWaived: true }).body, /waived/i);
  assert.doesNotMatch(decisionCopyFor("approved", { depositWaived: true }).body, /Stripe/i);
  const unauthorized = await approveApplication(context(""));
  assert.equal(unauthorized.status, 401);
  const missingIdempotency = await approveApplication({
    ...context("Bearer test-service-token"), params: { id: "app-1" },
  });
  assert.equal(missingIdempotency.status, 400);
  const unsupported = await approveApplication({
    ...context("Bearer test-service-token"),
    params: { id: "app-1" },
    request: new Request("https://www.rightmindcreative.co/api/simon/applications/app-1/decision", {
      method: "POST",
      headers: {
        authorization: "Bearer test-service-token",
        "content-type": "application/json",
        "idempotency-key": "approval-1",
      },
      body: JSON.stringify({ decision: "approved", waiveDeposit: false }),
    }),
  });
  assert.equal(unsupported.status, 422);
});

test("Simon waiver rollback requires authentication and an idempotency key", async () => {
  const unauthorized = await rollbackWaiver({
    ...context(""), params: { id: "app-1" },
    request: new Request("https://www.rightmindcreative.co/api/simon/applications/app-1/rollback-waiver", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }),
  });
  assert.equal(unauthorized.status, 401);
  const missingKey = await rollbackWaiver({
    ...context("Bearer test-service-token"), params: { id: "app-1" },
    request: new Request("https://www.rightmindcreative.co/api/simon/applications/app-1/rollback-waiver", {
      method: "POST", headers: {
        authorization: "Bearer test-service-token", "content-type": "application/json",
      }, body: JSON.stringify({
        action: "revert_erroneous_waiver", restoreStatus: "new", expectedArtistName: "ybexe",
      }),
    }),
  });
  assert.equal(missingKey.status, 400);
});

test("Simon booking split fails closed before reading private booking data", async () => {
  const unauthorized = await splitBooking({
    ...context(""), params: { id: "booking-1" },
    request: new Request(
      "https://www.rightmindcreative.co/api/simon/bookings/booking-1/split",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ),
  });
  assert.equal(unauthorized.status, 401);
  const missingKey = await splitBooking({
    ...context("Bearer test-service-token"), params: { id: "booking-1" },
    request: new Request(
      "https://www.rightmindcreative.co/api/simon/bookings/booking-1/split",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-service-token",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
  });
  assert.equal(missingKey.status, 400);
});

test("cancelled approved applications emit a client notification with secure status link", () => {
  const event = applicationCancelledEvent({
    id: "app-2", phone: "+14025550102", public_status_token: "secure token",
  }, { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });
  assert.equal(event.type, "application.cancelled");
  assert.equal(event.id, "application-cancelled:app-2");
  assert.equal(event.application.phone, "+14025550102");
  assert.equal(
    event.application.statusUrl,
    "https://www.rightmindcreative.co/application-status?token=secure%20token",
  );
});

test("application decision emails have matching client text events", () => {
  const event = applicationReviewedEvent({
    id: "app-3", phone: "+14025550103", public_status_token: "review token",
  }, "approved", { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });
  assert.equal(event.type, "application.reviewed");
  assert.equal(event.id, "application-reviewed:app-3:approved");
  assert.equal(event.application.status, "approved");
  assert.equal(event.application.phone, "+14025550103");
  assert.equal(event.application.statusUrl, "https://www.rightmindcreative.co/application-status?token=review%20token");
});

test("manual and Simon reschedules emit unique client notification events", () => {
  const event = bookingRescheduledEvent({
    id: "booking-4", phone: "+14025550104", public_status_token: "status token",
    preferred_date: "2026-08-20", preferred_time: "4:00 PM",
    updated_at: "2026-08-14T18:00:00.000Z",
  }, { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });
  assert.equal(event.type, "booking.rescheduled");
  assert.equal(event.id, "booking-rescheduled:booking-4:2026-08-14T18:00:00.000Z");
  assert.equal(event.booking.phone, "+14025550104");
  assert.equal(event.booking.preferredDate, "2026-08-20");
  assert.equal(event.booking.statusUrl, "https://www.rightmindcreative.co/application-status?token=status%20token");
});
