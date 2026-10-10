import assert from "node:assert/strict";
import test from "node:test";

import {
  actorMatches, authenticateSimonV3, matchSimonV3Route, parseVersion,
  SIMON_V3_ROUTES,
} from "../functions/_lib/simon-v3.js";
import { onRequest } from "../functions/api/simon/v3/[[path]].js";

const PERSON_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";
const TRACE_ID = "33333333-3333-4333-8333-333333333333";

const actor = { person_id: PERSON_ID, role: "admin", authority_grant_id: GRANT_ID };
const headers = (extra = {}) => ({
  authorization: "Bearer staging-token",
  "x-simon-person-id": PERSON_ID,
  "x-simon-role": "admin",
  "x-simon-authority-grant-id": GRANT_ID,
  "x-simon-trace-id": TRACE_ID,
  ...extra,
});

const inertDb = () => ({
  prepare() {
    return {
      bind() { return this; },
      async first() { return null; },
      async all() { return { results: [] }; },
      async run() { return { success: true }; },
    };
  },
  async batch() { return []; },
});

const statefulCalendarDb = () => {
  const resources = new Map();
  const operations = new Map();
  const events = [];
  const execute = (sql, values) => {
    if (sql.includes("INSERT INTO simon_v3_operations")) {
      const [id, action, idempotency_key, request_hash, trace_id,
        requester_person_id, requester_role, resource_refs_json, steps_json,
        before_json, created_at] = values;
      operations.set(id, {
        id, action, idempotency_key, request_hash, trace_id, requester_person_id,
        requester_role, status: "pending", resource_refs_json, steps_json,
        rollback_json: '{"available":false}', before_json, after_json: null,
        created_at, completed_at: null,
      });
    } else if (sql.includes("INSERT INTO simon_v3_resources")) {
      const booking = sql.includes("'booking'");
      const [id, stateOrOwner, ownerOrData, dataOrCreated, createdOrUpdated, maybeUpdated] = values;
      const literal = sql.match(/VALUES\s*\(\?,\s*'([^']+)',\s*1,\s*'([^']+)'/s);
      const kind = booking ? "booking" : literal?.[1] || "calendar_hold";
      const state = booking ? stateOrOwner : literal?.[2] || "active";
      const owner_person_id = booking ? ownerOrData : stateOrOwner;
      const data_json = booking ? dataOrCreated : ownerOrData;
      const created_at = booking ? createdOrUpdated : dataOrCreated;
      const updated_at = booking ? maybeUpdated : createdOrUpdated;
      resources.set(id, {
        id, kind, version: 1, state, owner_person_id,
        data_json, archived: 0, created_at, updated_at,
      });
    } else if (sql.includes("UPDATE simon_v3_operations SET status = 'succeeded'")) {
      const [resource_refs_json, steps_json, after_json, completed_at, id] = values;
      Object.assign(operations.get(id), {
        status: "succeeded", resource_refs_json, steps_json, after_json, completed_at,
      });
    } else if (sql.includes("UPDATE simon_v3_resources SET version")) {
      const restoresState = sql.includes("state = ?");
      const [version, stateOrData, dataOrUpdated, updatedOrId, maybeId] = values;
      const id = restoresState ? maybeId : updatedOrId;
      const existing = resources.get(id);
      Object.assign(existing, {
        version,
        state: sql.includes("state = 'cancelled'")
          ? "cancelled"
          : restoresState ? stateOrData : existing.state,
        data_json: restoresState ? dataOrUpdated : stateOrData,
        updated_at: restoresState ? updatedOrId : dataOrUpdated,
      });
    } else if (sql.includes("INSERT INTO simon_v3_events")) {
      events.push(values);
    }
    return { success: true };
  };
  return {
    resources, operations, events,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("json_extract(data_json, '$.stripe_reference')")) {
            return [...resources.values()].find((row) => (
              row.kind === "ledger_entry"
              && JSON.parse(row.data_json).stripe_reference === this.values[0]
            )) || null;
          }
          if (sql.includes("FROM simon_v3_resources")) return resources.get(this.values[0]) || null;
          if (sql.includes("idempotency_key")) {
            return [...operations.values()].find((row) => row.idempotency_key === this.values[0]) || null;
          }
          if (sql.includes("FROM simon_v3_operations")) return operations.get(this.values[0]) || null;
          return null;
        },
        async all() {
          if (sql.includes("kind = 'ledger_entry'")) {
            return { results: [...resources.values()].filter((row) => (
              row.kind === "ledger_entry" && JSON.parse(row.data_json).booking_id === this.values[0]
            )) };
          }
          if (sql.includes("kind = 'payment_link'")) {
            const [owner, bookingId, amount] = this.values;
            return { results: [...resources.values()].filter((row) => {
              if (row.kind !== "payment_link" || row.owner_person_id !== owner) return false;
              const data = JSON.parse(row.data_json);
              return data.booking_id === bookingId && (amount === undefined || data.amount_minor === amount)
                && (!sql.includes("state = 'unpaid'") || row.state === "unpaid");
            }).slice(0, 25) };
          }
          return { results: [] };
        },
        async run() { return execute(sql, this.values); },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    },
  };
};

const context = (request, env = {}) => ({
  request,
  env: { APPLICATIONS_DB: inertDb(), SIMON_V3_SERVICE_TOKEN: "staging-token", ...env },
  waitUntil() {},
});

test("Simon V3 route table covers every formal operation exactly once", () => {
  assert.equal(SIMON_V3_ROUTES.length, 61);
  assert.equal(SIMON_V3_ROUTES.filter((route) => route.mode === "mutation").length, 34);
  assert.equal(new Set(SIMON_V3_ROUTES.map((route) => route.operationId)).size, 61);
});

test("route matching preserves contract operation IDs and path parameters", () => {
  const match = matchSimonV3Route(
    "POST",
    `/api/simon/v3/bookings/${PERSON_ID}/reschedule`,
  );
  assert.equal(match.operationId, "rescheduleBooking");
  assert.equal(match.params.booking_id, PERSON_ID);
  assert.equal(match.ifMatch, true);
});

test("actor authentication requires the service token and all three actor headers", async () => {
  const request = new Request("https://preview.example/api/simon/v3/catalog", { headers: headers() });
  assert.deepEqual(authenticateSimonV3(request, context(request).env).actor, actor);

  const missingActor = new Request("https://preview.example/api/simon/v3/catalog", {
    headers: { authorization: "Bearer staging-token" },
  });
  assert.equal(authenticateSimonV3(missingActor, context(missingActor).env).error.status, 401);

  const wrongToken = new Request("https://preview.example/api/simon/v3/catalog", {
    headers: headers({ authorization: "Bearer wrong" }),
  });
  assert.equal(authenticateSimonV3(wrongToken, context(wrongToken).env).error.status, 401);
});

test("header actor and body actor must match exactly", () => {
  assert.equal(actorMatches(actor, actor), true);
  assert.equal(actorMatches(actor, { ...actor, role: "client" }), false);
  assert.equal(actorMatches(actor, { ...actor, authority_grant_id: TRACE_ID }), false);
});

test("optimistic concurrency versions accept standard ETags only", () => {
  assert.equal(parseVersion('W/"7"'), 7);
  assert.equal(parseVersion('"8"'), 8);
  assert.equal(parseVersion("9"), 9);
  assert.equal(parseVersion("anything"), null);
});

test("mutations reject a mismatched body actor before any write", async () => {
  const request = new Request("https://preview.example/api/simon/v3/clients", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "client-create-0001" }),
    body: JSON.stringify({ actor: { ...actor, role: "client" }, reason: "test", data: {} }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "validation_error");
});

test("mutations reject undeclared top-level fields", async () => {
  const request = new Request("https://preview.example/api/simon/v3/clients", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "client-create-0002" }),
    body: JSON.stringify({ actor, reason: "test", data: {}, unexpected: true }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "validation_error");
});

test("provider-backed operations never return false success without a receipt", async () => {
  const request = new Request("https://preview.example/api/simon/v3/notifications", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "notification-guard-0001" }),
    body: JSON.stringify({ actor, reason: "test provider guard", data: {} }),
  });
  const response = await onRequest(context(request));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "provider_failure");
  assert.equal(typeof body.operation_id, "string");
});

test("staging calendar availability returns only busy-safe fields with evidence", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests += 1;
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    assert.equal(String(url), "https://www.googleapis.com/calendar/v3/freeBusy");
    return new Response(JSON.stringify({
      calendars: { "staging-calendar": { busy: [] } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const request = new Request("https://preview.example/api/simon/v3/calendar/availability", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      actor,
      data: { starts_at: "2026-10-13T15:00:00.000Z", duration_minutes: 120 },
    }),
  });
  const response = await onRequest(context(request, {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "staging@example.test",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    GOOGLE_CALENDAR_ID: "staging-calendar",
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
  assert.equal(body.items.length, 1);
  assert.deepEqual(Object.keys(body.items[0].data).sort(), [
    "available", "ends_at", "policy_eligible", "policy_reason", "starts_at",
  ]);
  assert.equal(body.items[0].data.available, true);
  assert.equal(body.items[0].evidence_refs.length, 1);
  assert.equal(JSON.stringify(body).includes("summary"), false);
  assert.equal(JSON.stringify(body).includes("attendee"), false);
});

test("staging calendar availability validates the complete interval before provider access", async () => {
  const request = new Request("https://preview.example/api/simon/v3/calendar/availability", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ actor, data: { starts_at: "2026-10-13T15:00:00.000Z" } }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "validation_error");
});

test("dependency health confirms Stripe test mode without exposing account data", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.stripe.com/v1/balance");
    assert.equal(options.headers.authorization, "Bearer private-test-key");
    return new Response(JSON.stringify({
      livemode: false,
      available: [{ amount: 123456, currency: "usd", source_types: { card: 123456 } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const request = new Request("https://preview.example/api/simon/v3/health", {
    headers: headers(),
  });
  const response = await onRequest(context(request, { STRIPE_SECRET_KEY: "private-test-key" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  const stripe = body.items.find((item) => item.data.dependency === "stripe");
  assert.deepEqual(stripe.data, {
    dependency: "stripe", state: "ready", mode: "test", environment: "staging",
  });
  assert.equal(JSON.stringify(body).includes("123456"), false);
  assert.equal(JSON.stringify(body).includes("private-test-key"), false);
});

test("staging calendar hold create and cancel require confirmed provider receipts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  let createdProviderId = "";
  let createdPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      createdPayload = payload;
      createdProviderId = payload.id;
      return new Response(JSON.stringify({ id: payload.id, etag: "test-etag", status: "confirmed" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (options.method === "PATCH") {
      return new Response(JSON.stringify({ id: createdProviderId, etag: "updated-etag", status: "confirmed" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    assert.equal(options.method, "DELETE");
    assert.equal(String(url).includes(createdProviderId), true);
    return new Response(null, { status: 204 });
  };
  const db = statefulCalendarDb();
  const env = {
    APPLICATIONS_DB: db,
    SIMON_V3_SERVICE_TOKEN: "staging-token",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "staging@example.test",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    GOOGLE_CALENDAR_ID: "staging-calendar",
  };
  const holdId = "44444444-4444-4444-8444-444444444444";
  const createRequest = new Request("https://preview.example/api/simon/v3/calendar/holds", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "calendar-hold-create-0001" }),
    body: JSON.stringify({
      actor, reason: "staging compensation drill",
      data: {
        id: holdId, summary: "Simon staging verification hold",
        start_date: "2026-10-20", end_date: "2026-10-21",
        recurrence: { frequency: "weekly", interval: 2, count: 3 },
      },
    }),
  });
  const created = await onRequest(context(createRequest, env));
  assert.equal(created.status, 202);
  assert.equal((await created.json()).steps[0].provider_confirmed, true);
  assert.equal(db.resources.get(holdId).state, "active");
  assert.deepEqual(createdPayload.start, { date: "2026-10-20" });
  assert.deepEqual(createdPayload.recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3"]);

  const updateRequest = new Request(`https://preview.example/api/simon/v3/calendar/holds/${holdId}`, {
    method: "PATCH",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "calendar-hold-update-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({
      actor, reason: "verify provider-backed hold update",
      data: { summary: "Updated staging verification hold" },
    }),
  });
  const updated = await onRequest(context(updateRequest, env));
  assert.equal(updated.status, 202);
  assert.equal((await updated.json()).steps[0].provider_confirmed, true);
  assert.equal(db.resources.get(holdId).version, 2);
  assert.equal(JSON.parse(db.resources.get(holdId).data_json).summary, "Updated staging verification hold");

  const cancelRequest = new Request(`https://preview.example/api/simon/v3/calendar/holds/${holdId}/cancel`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "calendar-hold-cancel-0001" }),
    body: JSON.stringify({ actor, reason: "complete staging compensation drill", data: {} }),
  });
  const cancelled = await onRequest(context(cancelRequest, env));
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).steps[0].provider_confirmed, true);
  assert.equal(db.resources.get(holdId).state, "cancelled");
  assert.equal(db.events.length, 6);
});

test("client actors cannot access the administrative client directory", async () => {
  const request = new Request("https://preview.example/api/simon/v3/clients", {
    headers: headers({ "x-simon-role": "client" }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});

test("client actors cannot create bookings directly", async () => {
  const request = new Request("https://preview.example/api/simon/v3/bookings", {
    method: "POST",
    headers: headers({
      "x-simon-role": "client", "content-type": "application/json",
      "idempotency-key": "client-booking-denied-0001",
    }),
    body: JSON.stringify({
      actor: { ...actor, role: "client" }, reason: "client must escalate", data: {},
    }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});

test("admin booking create, edit, reschedule, split, cancel, and restore require Google receipts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  let providerId = "";
  let deleteCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test" }), { status: 200 });
    }
    if (String(url).endsWith("/freeBusy")) {
      return new Response(JSON.stringify({ calendars: { "staging-calendar": { busy: [] } } }), { status: 200 });
    }
    if (options.method === "POST") {
      providerId = JSON.parse(options.body).id;
      return new Response(JSON.stringify({ id: providerId, etag: "booking-etag", status: "confirmed" }), { status: 200 });
    }
    if (options.method === "PATCH") {
      return new Response(JSON.stringify({ id: providerId, etag: "reschedule-etag", status: "confirmed" }), { status: 200 });
    }
    assert.equal(options.method, "DELETE");
    deleteCount += 1;
    return new Response(null, { status: 204 });
  };
  const db = statefulCalendarDb();
  const env = {
    APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "staging@example.test",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey, GOOGLE_CALENDAR_ID: "staging-calendar",
  };
  const bookingId = "55555555-5555-4555-8555-555555555555";
  const createRequest = new Request("https://preview.example/api/simon/v3/bookings", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "booking-create-admin-0001" }),
    body: JSON.stringify({ actor, reason: "admin confirmed booking", data: {
      id: bookingId, owner_person_id: PERSON_ID, summary: "Synthetic booking",
      service_id: "vocal-recording", starts_at: "2026-10-20T18:00:00Z",
      ends_at: "2026-10-20T20:00:00Z", payment_state: "deposit_waived",
      agreed_total_minor: 20000, currency: "USD",
    } }),
  });
  const created = await onRequest(context(createRequest, env));
  assert.equal(created.status, 202);
  assert.equal(db.resources.get(bookingId).state, "booked");
  const rescheduleRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/reschedule`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-reschedule-admin-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({ actor, reason: "reschedule synthetic booking", data: {
      starts_at: "2026-10-21T18:00:00Z", ends_at: "2026-10-21T20:00:00Z",
    } }),
  });
  const rescheduled = await onRequest(context(rescheduleRequest, env));
  assert.equal(rescheduled.status, 202);
  assert.equal(db.resources.get(bookingId).version, 2);
  const updateRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}`, {
    method: "PATCH",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-update-admin-0001",
      "if-match": "2",
    }),
    body: JSON.stringify({ actor, reason: "edit synthetic booking", data: {
      summary: "Updated synthetic booking", service_id: "recording-session",
    } }),
  });
  const updated = await onRequest(context(updateRequest, env));
  assert.equal(updated.status, 202);
  assert.equal(db.resources.get(bookingId).version, 3);
  const secondBookingId = "66666666-6666-4666-8666-666666666666";
  const splitRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/split`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-split-admin-0001",
      "if-match": "3",
    }),
    body: JSON.stringify({ actor, reason: "split synthetic booking", data: {
      first_duration_minutes: 60, second_duration_minutes: 60,
      second_starts_at: "2026-10-23T18:00:00Z", second_booking_id: secondBookingId,
    } }),
  });
  const split = await onRequest(context(splitRequest, env));
  assert.equal(split.status, 202);
  assert.equal(db.resources.get(bookingId).version, 4);
  assert.equal(db.resources.get(secondBookingId).version, 1);
  assert.equal(JSON.parse(db.resources.get(secondBookingId).data_json).payment_ledger_booking_id, bookingId);
  const cancelRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/cancel`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-cancel-admin-0001",
      "if-match": "4",
    }),
    body: JSON.stringify({ actor, reason: "cancel synthetic booking", data: {} }),
  });
  const cancelled = await onRequest(context(cancelRequest, env));
  assert.equal(cancelled.status, 202);
  assert.equal(db.resources.get(bookingId).state, "cancelled");
  assert.equal(db.resources.get(bookingId).version, 5);
  const cancelSecondRequest = new Request(`https://preview.example/api/simon/v3/bookings/${secondBookingId}/cancel`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-second-cleanup-admin-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({ actor, reason: "clean up second synthetic booking", data: {} }),
  });
  const secondCancelled = await onRequest(context(cancelSecondRequest, env));
  assert.equal(secondCancelled.status, 202);
  assert.equal(db.resources.get(secondBookingId).state, "cancelled");
  const restoreRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/restore`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-restore-admin-0001",
    }),
    body: JSON.stringify({ actor, reason: "explicitly restore synthetic booking", data: {
      starts_at: "2026-10-22T18:00:00Z", ends_at: "2026-10-22T20:00:00Z",
    } }),
  });
  const restored = await onRequest(context(restoreRequest, env));
  assert.equal(restored.status, 202);
  assert.equal(db.resources.get(bookingId).state, "booked");
  assert.equal(db.resources.get(bookingId).version, 6);
  const cleanupRequest = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/cancel`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json", "idempotency-key": "booking-cleanup-admin-0001",
      "if-match": "6",
    }),
    body: JSON.stringify({ actor, reason: "clean up synthetic booking", data: {} }),
  });
  const cleaned = await onRequest(context(cleanupRequest, env));
  assert.equal(cleaned.status, 202);
  assert.equal(db.resources.get(bookingId).state, "cancelled");
  assert.equal(db.resources.get(bookingId).version, 7);
  assert.equal(deleteCount, 3);
  assert.equal(providerId.length > 10, true);
});

test("payment ledger enforces ownership, exact amounts, link receipts, and reconciliation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let checkoutRequests = 0;
  let checkoutMetadata = {};
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /api\.stripe\.com\/v1\/checkout\/sessions/);
    if (options.method === "POST") {
      checkoutRequests += 1;
      const form = new URLSearchParams(options.body);
      checkoutMetadata = {
        simon_v3_booking_id: form.get("metadata[simon_v3_booking_id]"),
        simon_v3_payment_link_id: form.get("metadata[simon_v3_payment_link_id]"),
      };
      return new Response(JSON.stringify({
        id: "cs_test_simon_v3", url: "https://checkout.stripe.test/simon-v3",
        payment_status: "unpaid", status: "open", amount_total: 5000,
        expires_at: Math.floor(Date.now() / 1000) + 3600, livemode: false,
        metadata: checkoutMetadata,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: "cs_test_simon_v3", payment_status: "paid", status: "complete",
      amount_total: 5000, payment_intent: "pi_test_simon_v3", livemode: false,
      metadata: checkoutMetadata,
    }), { status: 200 });
  };
  const db = statefulCalendarDb();
  const bookingId = "77777777-7777-4777-8777-777777777777";
  const timestamp = new Date().toISOString();
  db.resources.set(bookingId, {
    id: bookingId, kind: "booking", version: 1, state: "booked",
    owner_person_id: PERSON_ID, archived: 0, created_at: timestamp, updated_at: timestamp,
    data_json: JSON.stringify({
      id: bookingId, owner_person_id: PERSON_ID, agreed_total_minor: 20000,
      currency: "USD", payment_state: "deposit_waived", booking_state: "booked",
    }),
  });
  const env = { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token", STRIPE_SECRET_KEY: "sk_test_hidden" };
  const creditRequest = new Request("https://preview.example/api/simon/v3/payments/ledger-entries", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "ledger-credit-admin-0001" }),
    body: JSON.stringify({ actor, reason: "exact approved credit", data: {
      booking_id: bookingId, entry_kind: "credit", amount_minor: 2000, currency: "USD",
    } }),
  });
  assert.equal((await onRequest(context(creditRequest, env))).status, 202);
  const ledgerRequest = new Request(`https://preview.example/api/simon/v3/payments/ledgers/${bookingId}`, {
    headers: headers(),
  });
  const ledgerResponse = await onRequest(context(ledgerRequest, env));
  assert.equal(ledgerResponse.status, 200);
  assert.equal((await ledgerResponse.json()).data.remaining_minor, 18000);

  const clientActor = { ...actor, role: "client" };
  const clientHeaders = headers({ "x-simon-role": "client" });
  const partialRequest = new Request("https://preview.example/api/simon/v3/payments/links", {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json", "idempotency-key": "client-partial-link-0001" },
    body: JSON.stringify({ actor: clientActor, reason: "request a partial payment", data: {
      booking_id: bookingId, amount_minor: 5000,
    } }),
  });
  assert.equal((await onRequest(context(partialRequest, env))).status, 403);
  assert.equal(checkoutRequests, 0);

  const linkRequest = new Request("https://preview.example/api/simon/v3/payments/links", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "admin-exact-link-0001" }),
    body: JSON.stringify({ actor, reason: "approved exact installment", data: {
      booking_id: bookingId, amount_minor: 5000, purpose: "approved installment",
    } }),
  });
  assert.equal((await onRequest(context(linkRequest, env))).status, 202);
  assert.equal(checkoutRequests, 1);
  const link = [...db.resources.values()].find((row) => row.kind === "payment_link");
  assert.ok(link);
  const reconcileRequest = new Request("https://preview.example/api/simon/v3/payments/reconcile", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "reconcile-paid-link-0001" }),
    body: JSON.stringify({ actor, reason: "reconcile Stripe receipt", data: { payment_link_id: link.id } }),
  });
  assert.equal((await onRequest(context(reconcileRequest, env))).status, 202);
  assert.equal(db.resources.get(link.id).state, "paid");
  const finalLedger = await onRequest(context(ledgerRequest, env));
  assert.equal((await finalLedger.json()).data.remaining_minor, 13000);
});

test("refunds require an exact test-mode Stripe receipt linked to the booking", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bookingId = "88888888-8888-4888-8888-888888888888";
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.stripe.com/v1/refunds");
    assert.equal(options.method, "POST");
    const form = new URLSearchParams(options.body);
    return new Response(JSON.stringify({
      id: "re_test_simon_v3", status: "succeeded", amount: Number(form.get("amount")),
      payment_intent: form.get("payment_intent"), livemode: false,
      metadata: { simon_v3_booking_id: form.get("metadata[simon_v3_booking_id]") },
    }), { status: 200 });
  };
  const db = statefulCalendarDb();
  const timestamp = new Date().toISOString();
  db.resources.set(bookingId, {
    id: bookingId, kind: "booking", version: 1, state: "booked",
    owner_person_id: PERSON_ID, archived: 0, created_at: timestamp, updated_at: timestamp,
    data_json: JSON.stringify({ id: bookingId, owner_person_id: PERSON_ID, agreed_total_minor: 20000, currency: "USD" }),
  });
  const env = { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token", STRIPE_SECRET_KEY: "sk_test_hidden" };
  const request = new Request("https://preview.example/api/simon/v3/payments/refunds", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "refund-exact-admin-0001" }),
    body: JSON.stringify({ actor, reason: "approved partial refund", data: {
      booking_id: bookingId, payment_intent_id: "pi_test_simon_v3", amount_minor: 500,
    } }),
  });
  assert.equal((await onRequest(context(request, env))).status, 202);
  const refund = [...db.resources.values()].find((row) => row.kind === "refund");
  assert.equal(JSON.parse(refund.data_json).stripe_refund_id, "re_test_simon_v3");
  const ledgerRequest = new Request(`https://preview.example/api/simon/v3/payments/ledgers/${bookingId}`, { headers: headers() });
  const ledger = await onRequest(context(ledgerRequest, env));
  assert.equal((await ledger.json()).data.remaining_minor, 20500);
});
