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
      const [id, owner_person_id, data_json, created_at, updated_at] = values;
      resources.set(id, {
        id, kind: "calendar_hold", version: 1, state: "active", owner_person_id,
        data_json, archived: 0, created_at, updated_at,
      });
    } else if (sql.includes("UPDATE simon_v3_operations SET status = 'succeeded'")) {
      const [resource_refs_json, steps_json, after_json, completed_at, id] = values;
      Object.assign(operations.get(id), {
        status: "succeeded", resource_refs_json, steps_json, after_json, completed_at,
      });
    } else if (sql.includes("UPDATE simon_v3_resources SET version")) {
      const [version, data_json, updated_at, id] = values;
      Object.assign(resources.get(id), { version, state: "cancelled", data_json, updated_at });
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
          if (sql.includes("FROM simon_v3_resources")) return resources.get(this.values[0]) || null;
          if (sql.includes("idempotency_key")) {
            return [...operations.values()].find((row) => row.idempotency_key === this.values[0]) || null;
          }
          if (sql.includes("FROM simon_v3_operations")) return operations.get(this.values[0]) || null;
          return null;
        },
        async all() { return { results: [] }; },
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
  const request = new Request("https://preview.example/api/simon/v3/payments/links", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "payment-link-0001" }),
    body: JSON.stringify({ actor, reason: "test provider guard", data: { booking_id: PERSON_ID } }),
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

  const cancelRequest = new Request(`https://preview.example/api/simon/v3/calendar/holds/${holdId}/cancel`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "calendar-hold-cancel-0001" }),
    body: JSON.stringify({ actor, reason: "complete staging compensation drill", data: {} }),
  });
  const cancelled = await onRequest(context(cancelRequest, env));
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).steps[0].provider_confirmed, true);
  assert.equal(db.resources.get(holdId).state, "cancelled");
  assert.equal(db.events.length, 4);
});

test("client actors cannot access the administrative client directory", async () => {
  const request = new Request("https://preview.example/api/simon/v3/clients", {
    headers: headers({ "x-simon-role": "client" }),
  });
  const response = await onRequest(context(request));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});
