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
      if (sql.includes("'rolled_back'")) {
        const [id, action, idempotency_key, request_hash, trace_id,
          requester_person_id, requester_role, resource_refs_json, steps_json,
          rollback_json, before_json, after_json, created_at, completed_at] = values;
        operations.set(id, {
          id, action, idempotency_key, request_hash, trace_id, requester_person_id,
          requester_role, status: "rolled_back", resource_refs_json, steps_json,
          rollback_json, before_json, after_json, created_at, completed_at,
        });
        return { success: true };
      }
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
      const hasRollback = sql.includes("rollback_json = ?");
      const [resource_refs_json, steps_json, third, fourth, fifth, sixth] = values;
      const rollback_json = hasRollback ? third : operations.get(hasRollback ? sixth : fifth)?.rollback_json;
      const after_json = hasRollback ? fourth : third;
      const completed_at = hasRollback ? fifth : fourth;
      const id = hasRollback ? sixth : fifth;
      Object.assign(operations.get(id), {
        status: "succeeded", resource_refs_json, steps_json, rollback_json,
        after_json, completed_at,
      });
    } else if (sql.includes("UPDATE simon_v3_resources") && sql.includes("SET version")) {
      if (sql.includes("state = ?") && sql.includes("owner_person_id = ?") && sql.includes("archived = ?")) {
        const [version, state, owner_person_id, data_json, archived, updated_at, id] = values;
        Object.assign(resources.get(id), { version, state, owner_person_id, data_json, archived, updated_at });
        return { success: true };
      }
      if (sql.includes("state = 'archived'")) {
        const [version, owner_person_id, data_json, updated_at, id] = values;
        Object.assign(resources.get(id), {
          version, state: "archived", owner_person_id, data_json, archived: 1, updated_at,
        });
        return { success: true };
      }
      if (sql.includes("state = ?") && sql.includes("owner_person_id = ?") && sql.includes("archived = 0")) {
        const [version, state, owner_person_id, data_json, updated_at, id] = values;
        Object.assign(resources.get(id), {
          version, state, owner_person_id, data_json, archived: 0, updated_at,
        });
        return { success: true };
      }
      if (sql.includes("owner_person_id = ?") && !sql.includes("state =")) {
        const [version, owner_person_id, data_json, updated_at, id] = values;
        Object.assign(resources.get(id), { version, owner_person_id, data_json, updated_at });
        return { success: true };
      }
      const restoresState = sql.includes("state = ?");
      const [version, stateOrData, dataOrUpdated, updatedOrId, maybeId] = values;
      const id = restoresState ? maybeId : updatedOrId;
      const existing = resources.get(id);
      const literalState = sql.match(/state = '([^']+)'/s)?.[1];
      Object.assign(existing, {
        version,
        state: literalState
          ? literalState
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
          if (sql.includes("kind = 'notification'") && sql.includes("dedupe_key")) {
            return [...resources.values()].find((row) => (
              row.kind === "notification" && JSON.parse(row.data_json).dedupe_key === this.values[0]
            )) || null;
          }
          if (sql.includes("kind = 'assignment'") && sql.includes("booking_id")) {
            return [...resources.values()].find((row) => (
              row.kind === "assignment" && row.owner_person_id === this.values[0]
              && JSON.parse(row.data_json).booking_id === this.values[1]
              && ["pending", "accepted"].includes(row.state)
            )) || null;
          }
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
          if (sql.includes("owner_person_id = ?") && sql.includes("id NOT IN")) {
            const [owner, firstExcluded, secondExcluded] = this.values;
            return { results: [...resources.values()].filter((row) => (
              row.owner_person_id === owner
              && row.id !== firstExcluded
              && row.id !== secondExcluded
            )) };
          }
          if (sql.includes("retention_expires_at")) {
            const cutoff = Date.parse(this.values[0]);
            return { results: [...resources.values()].filter((row) => {
              if (row.kind !== "file" || !["ready", "expiring"].includes(row.state)) return false;
              const data = JSON.parse(row.data_json);
              return data.scan_state === "clean"
                && Date.parse(data.retention_expires_at || "") <= cutoff;
            }).slice(0, 25) };
          }
          if (sql.includes("kind = 'ledger_entry'")) {
            return { results: [...resources.values()].filter((row) => (
              row.kind === "ledger_entry" && JSON.parse(row.data_json).booking_id === this.values[0]
            )) };
          }
          if (sql.includes("kind = 'payment_link'")) {
            const ownerScoped = sql.includes("owner_person_id = ?");
            const [owner, bookingId, amount] = ownerScoped
              ? this.values : [undefined, this.values[0], undefined];
            return { results: [...resources.values()].filter((row) => {
              if (row.kind !== "payment_link" || (ownerScoped && row.owner_person_id !== owner)) return false;
              const data = JSON.parse(row.data_json);
              return data.booking_id === bookingId && (amount === undefined || data.amount_minor === amount)
                && (!sql.includes("state = 'unpaid'") || row.state === "unpaid");
            }).slice(0, 25) };
          }
          if (sql.includes("kind = 'notification'")) {
            return { results: [...resources.values()].filter((row) => (
              row.kind === "notification" && JSON.parse(row.data_json).related_id === this.values[0]
            )) };
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
  assert.equal(SIMON_V3_ROUTES.length, 64);
  assert.equal(SIMON_V3_ROUTES.filter((route) => route.mode === "mutation").length, 36);
  assert.equal(new Set(SIMON_V3_ROUTES.map((route) => route.operationId)).size, 64);
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

test("shadow credential permits reads but rejects all 36 mutations before state access", async () => {
  const db = statefulCalendarDb();
  const env = {
    APPLICATIONS_DB: db,
    SIMON_V3_SERVICE_TOKEN: "staging-token",
    SIMON_V3_SHADOW_TOKEN: "shadow-read-only-token",
  };
  const shadowHeaders = {
    ...headers(),
    authorization: "Bearer shadow-read-only-token",
  };
  const read = new Request("https://preview.example/api/simon/v3/catalog", {
    headers: shadowHeaders,
  });
  assert.equal((await onRequest(context(read, env))).status, 200);
  assert.equal(db.events.length, 0);

  const mutations = SIMON_V3_ROUTES.filter((route) => route.mode === "mutation");
  assert.equal(mutations.length, 36);
  for (const route of mutations) {
    const path = route.pattern.replace(/:[a-z_]+/g, PERSON_ID);
    const mutation = new Request(`https://preview.example/api/simon/v3${path}`, {
      method: route.method,
      headers: { ...shadowHeaders, "content-type": "application/json", "idempotency-key": `shadow-denied-${route.operationId}` },
      body: JSON.stringify({ actor, reason: "must be denied", data: {} }),
    });
    const denied = await onRequest(context(mutation, env));
    assert.equal(denied.status, 403, route.operationId);
    assert.equal((await denied.json()).code, "shadow_read_only", route.operationId);
  }
  assert.equal(db.resources.size, 0);
  assert.equal(db.operations.size, 0);
  assert.equal(db.events.length, 0);
});

test("identical service and shadow credentials fail closed", async () => {
  const request = new Request("https://preview.example/api/simon/v3/catalog", {
    headers: headers(),
  });
  const response = await onRequest(context(request, {
    SIMON_V3_SERVICE_TOKEN: "staging-token",
    SIMON_V3_SHADOW_TOKEN: "staging-token",
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "provider_failure");
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

test("client merge rejects incomplete selections instead of returning false success", async () => {
  const request = new Request("https://preview.example/api/simon/v3/clients/merge", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "merge-provider-guard-0001" }),
    body: JSON.stringify({ actor, reason: "test provider guard", data: {} }),
  });
  const response = await onRequest(context(request));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, "validation_error");
});

test("client merge atomically reassigns records, preserves identities, and rolls back safely", async () => {
  const db = statefulCalendarDb();
  const sourceId = "41414141-4141-4414-8414-414141414141";
  const targetId = "42424242-4242-4424-8424-424242424242";
  const applicationId = "43434343-4343-4434-8434-434343434343";
  const fileId = "44444444-4444-4444-8444-444444444444";
  const timestamp = new Date().toISOString();
  const original = [
    {
      id: sourceId, kind: "client", version: 1, state: "active", owner_person_id: sourceId,
      data_json: JSON.stringify({ id: sourceId, owner_person_id: sourceId, name: "Source Name", email: "source@example.test", artist_name: "Night Bloom" }),
      archived: 0, created_at: timestamp, updated_at: timestamp,
    },
    {
      id: targetId, kind: "client", version: 1, state: "active", owner_person_id: targetId,
      data_json: JSON.stringify({ id: targetId, owner_person_id: targetId, name: "Target Name", email: "target@example.test", artist_name: "Moon Room" }),
      archived: 0, created_at: timestamp, updated_at: timestamp,
    },
    {
      id: applicationId, kind: "application", version: 1, state: "draft", owner_person_id: sourceId,
      data_json: JSON.stringify({ id: applicationId, owner_person_id: sourceId, summary: "Preserved project" }),
      archived: 0, created_at: timestamp, updated_at: timestamp,
    },
    {
      id: fileId, kind: "file", version: 1, state: "ready", owner_person_id: sourceId,
      data_json: JSON.stringify({ id: fileId, owner_person_id: sourceId, target_record_kind: "client", target_record_id: sourceId, checksum_sha256: "a".repeat(64) }),
      archived: 0, created_at: timestamp, updated_at: timestamp,
    },
  ];
  for (const row of original) db.resources.set(row.id, { ...row });
  const env = { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token" };
  const mergeRequest = (key, sourceVersion, targetVersion, resolutions) => new Request(
    "https://preview.example/api/simon/v3/clients/merge",
    {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": key }),
      body: JSON.stringify({ actor, reason: "merge two explicitly selected duplicate clients", data: {
        source_client_id: sourceId, target_client_id: targetId,
        source_version: sourceVersion, target_version: targetVersion,
        field_resolutions: resolutions,
      } }),
    },
  );
  const unresolved = await onRequest(context(mergeRequest("client-merge-unresolved-0001", 1, 1, {}), env));
  assert.equal(unresolved.status, 409);
  assert.deepEqual((await unresolved.json()).conflicting_fields, ["artist_name", "email", "name"]);
  assert.equal(db.operations.size, 0);

  const resolutions = { name: "target", email: "source", artist_name: "target" };
  const mergedResponse = await onRequest(context(mergeRequest("client-merge-complete-0002", 1, 1, resolutions), env));
  assert.equal(mergedResponse.status, 202);
  const mergedOperation = await mergedResponse.json();
  assert.equal(mergedOperation.status, "succeeded");
  assert.equal(mergedOperation.rollback.available, true);
  assert.equal(db.resources.get(sourceId).state, "archived");
  assert.equal(db.resources.get(sourceId).archived, 1);
  assert.equal(db.resources.get(sourceId).owner_person_id, targetId);
  const targetData = JSON.parse(db.resources.get(targetId).data_json);
  assert.equal(targetData.name, "Target Name");
  assert.equal(targetData.email, "source@example.test");
  assert.deepEqual(targetData.artist_identities, ["Moon Room", "Night Bloom"]);
  assert.equal(db.resources.get(applicationId).owner_person_id, targetId);
  assert.equal(JSON.parse(db.resources.get(applicationId).data_json).owner_person_id, targetId);
  assert.equal(JSON.parse(db.resources.get(fileId).data_json).target_record_id, targetId);

  const rollbackRequest = (operationId, key) => new Request(
    `https://preview.example/api/simon/v3/operations/${operationId}/rollback`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": key }),
      body: JSON.stringify({ actor, reason: "roll back the isolated client merge", data: {} }),
    },
  );
  const rolledBack = await onRequest(context(rollbackRequest(mergedOperation.id, "client-merge-rollback-0003"), env));
  assert.equal(rolledBack.status, 202);
  assert.equal((await rolledBack.json()).status, "rolled_back");
  assert.equal(db.resources.get(sourceId).state, "active");
  assert.equal(db.resources.get(sourceId).archived, 0);
  assert.equal(db.resources.get(sourceId).owner_person_id, sourceId);
  assert.equal(db.resources.get(applicationId).owner_person_id, sourceId);
  assert.equal(JSON.parse(db.resources.get(fileId).data_json).target_record_id, sourceId);

  const mergedAgain = await onRequest(context(mergeRequest("client-merge-stale-0004", 3, 3, resolutions), env));
  assert.equal(mergedAgain.status, 202);
  const secondOperation = await mergedAgain.json();
  db.resources.get(applicationId).version += 1;
  const staleRollback = await onRequest(context(rollbackRequest(secondOperation.id, "client-merge-stale-rollback-0005"), env));
  assert.equal(staleRollback.status, 409);
  assert.equal((await staleRollback.json()).code, "version_conflict");
  assert.equal(db.resources.get(sourceId).state, "archived");
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

test("notification outbox deduplicates and assignment responses stay role scoped", async () => {
  const db = statefulCalendarDb();
  const timestamp = new Date().toISOString();
  const bookingId = "99999999-9999-4999-8999-999999999999";
  const employeeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.resources.set(bookingId, {
    id: bookingId, kind: "booking", version: 1, state: "booked", owner_person_id: PERSON_ID,
    archived: 0, created_at: timestamp, updated_at: timestamp,
    data_json: JSON.stringify({ id: bookingId, summary: "Synthetic assigned session" }),
  });
  db.resources.set(employeeId, {
    id: employeeId, kind: "employee", version: 1, state: "active", owner_person_id: employeeId,
    archived: 0, created_at: timestamp, updated_at: timestamp,
    data_json: JSON.stringify({ id: employeeId, name: "Synthetic Engineer" }),
  });
  const env = { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token" };
  const assignmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const create = new Request("https://preview.example/api/simon/v3/assignments", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "assignment-create-0001" }),
    body: JSON.stringify({ actor, reason: "assign synthetic engineer", data: {
      id: assignmentId, booking_id: bookingId, employee_person_id: employeeId,
    } }),
  });
  assert.equal((await onRequest(context(create, env))).status, 202);
  assert.equal(db.resources.get(assignmentId).state, "pending");
  const employeeActor = { person_id: employeeId, role: "employee", authority_grant_id: GRANT_ID };
  const respond = new Request(`https://preview.example/api/simon/v3/assignments/${assignmentId}/respond`, {
    method: "POST",
    headers: {
      ...headers({ "x-simon-person-id": employeeId, "x-simon-role": "employee" }),
      "content-type": "application/json", "idempotency-key": "assignment-response-0001",
    },
    body: JSON.stringify({ actor: employeeActor, reason: "accept synthetic assignment", data: { response: "accepted" } }),
  });
  assert.equal((await onRequest(context(respond, env))).status, 202);
  assert.equal(db.resources.get(assignmentId).state, "accepted");
  assert.equal([...db.resources.values()].filter((row) => row.kind === "notification").length, 2);

  const notificationBody = { actor, reason: "queue one deduplicated alert", data: {
    recipient_person_id: PERSON_ID, channel: "sms", template: "staging_notice",
    dedupe_key: "staging-notice-one", variables: {},
  } };
  for (const key of ["notification-dedupe-0001", "notification-dedupe-0002"]) {
    const request = new Request("https://preview.example/api/simon/v3/notifications", {
      method: "POST", headers: headers({ "content-type": "application/json", "idempotency-key": key }),
      body: JSON.stringify(notificationBody),
    });
    assert.equal((await onRequest(context(request, env))).status, 202);
  }
  assert.equal([...db.resources.values()].filter((row) => (
    row.kind === "notification" && JSON.parse(row.data_json).dedupe_key === "staging-notice-one"
  )).length, 1);
});

test("staging notification probe records a verified Gmail receipt without client data", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  );
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 });
    }
    if (target.endsWith("/messages/send")) {
      const payload = JSON.parse(options.body);
      assert.match(payload.raw, /^[A-Za-z0-9_-]+$/);
      assert.equal(String(options.headers.authorization), "Bearer test-token");
      return new Response(JSON.stringify({
        id: "gmail-staging-receipt", labelIds: ["SENT"],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const db = statefulCalendarDb();
  const notificationId = "14141414-1414-4414-8414-141414141414";
  const request = new Request("https://preview.example/api/simon/v3/notifications", {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "idempotency-key": "staging-gmail-delivery-0001",
    }),
    body: JSON.stringify({
      actor,
      reason: "verify isolated staging delivery",
      data: {
        id: notificationId,
        audience_role: "admin",
        channel: "email",
        template: "staging_delivery_probe",
        dedupe_key: "staging-gmail-delivery-0001",
        variables: {},
      },
    }),
  });
  const env = {
    APPLICATIONS_DB: db,
    SIMON_V3_SERVICE_TOKEN: "staging-token",
    SIMON_V3_ENVIRONMENT: "staging",
    SIMON_V3_STAGING_NOTIFICATION_EMAIL: "welcome@rightmindcreative.co",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "staging@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    GOOGLE_EMAIL_IMPERSONATED_USER: "welcome@rightmindcreative.co",
    DECISION_EMAIL_FROM: "welcome@rightmindcreative.co",
  };
  const response = await onRequest(context(request, env));
  assert.equal(response.status, 202);
  const stored = db.resources.get(notificationId);
  assert.equal(stored.state, "delivered");
  const data = JSON.parse(stored.data_json);
  assert.equal(data.provider_receipt, "gmail-staging-receipt");
  assert.equal(data.attempts, 1);
  assert.equal("recipient_email" in data, false);
  const operation = await response.json();
  assert.equal(operation.steps.at(-1).provider_confirmed, true);
  assert.equal(operation.steps.at(-1).provider_receipt_ref, "gmail-staging-receipt");
});

test("application submission and deposit approval coordinate calendar, Stripe, and outbox receipts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "test" }), { status: 200 });
    if (target.endsWith("/freeBusy")) return new Response(JSON.stringify({ calendars: { "staging-calendar": { busy: [] } } }), { status: 200 });
    if (target.endsWith("/expire")) return new Response(JSON.stringify({ id: "cs_test_application_deposit", status: "expired", livemode: false }), { status: 200 });
    if (target.includes("api.stripe.com/v1/checkout/sessions")) {
      const form = new URLSearchParams(options.body);
      return new Response(JSON.stringify({
        id: "cs_test_application_deposit", url: "https://checkout.stripe.test/deposit",
        payment_status: "unpaid", status: "open", amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
        expires_at: Math.floor(Date.now() / 1000) + 3600, livemode: false,
        metadata: {
          simon_v3_booking_id: form.get("metadata[simon_v3_booking_id]"),
          simon_v3_payment_link_id: form.get("metadata[simon_v3_payment_link_id]"),
        },
      }), { status: 200 });
    }
    if (options.method === "POST") {
      const event = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: event.id, etag: "approval-event", status: "confirmed" }), { status: 200 });
    }
    assert.equal(options.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  const db = statefulCalendarDb();
  const applicationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const bookingId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const timestamp = new Date().toISOString();
  db.resources.set(applicationId, {
    id: applicationId, kind: "application", version: 1, state: "draft", owner_person_id: PERSON_ID,
    archived: 0, created_at: timestamp, updated_at: timestamp,
    data_json: JSON.stringify({ id: applicationId, owner_person_id: PERSON_ID, project_description: "Synthetic project" }),
  });
  const env = {
    APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token", STRIPE_SECRET_KEY: "sk_test_hidden",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "staging@example.test", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    GOOGLE_CALENDAR_ID: "staging-calendar",
  };
  const submit = new Request(`https://preview.example/api/simon/v3/applications/${applicationId}/submit`, {
    method: "POST", headers: headers({ "content-type": "application/json", "idempotency-key": "application-submit-0001" }),
    body: JSON.stringify({ actor, reason: "submit synthetic application", data: {} }),
  });
  assert.equal((await onRequest(context(submit, env))).status, 202);
  assert.equal(db.resources.get(applicationId).state, "awaiting_approval");
  const approve = new Request(`https://preview.example/api/simon/v3/applications/${applicationId}/approve-with-deposit`, {
    method: "POST", headers: headers({ "content-type": "application/json", "idempotency-key": "application-approve-deposit-0001" }),
    body: JSON.stringify({ actor, reason: "approve with exact deposit", data: {
      booking_id: bookingId, summary: "Synthetic approved session", service_id: "vocal-recording",
      starts_at: "2026-11-20T18:00:00Z", ends_at: "2026-11-20T20:00:00Z",
      agreed_total_minor: 20000, deposit_amount_minor: 7000, currency: "USD",
    } }),
  });
  const approved = await onRequest(context(approve, env));
  assert.equal(approved.status, 202);
  assert.equal(db.resources.get(applicationId).state, "approved");
  assert.equal(db.resources.get(bookingId).state, "held");
  assert.equal([...db.resources.values()].filter((row) => row.kind === "payment_link").length, 1);
  const cleanup = new Request(`https://preview.example/api/simon/v3/bookings/${bookingId}/cancel`, {
    method: "POST", headers: headers({
      "content-type": "application/json", "idempotency-key": "application-booking-cleanup-0001", "if-match": "1",
    }), body: JSON.stringify({ actor, reason: "clean synthetic approved booking", data: {} }),
  });
  assert.equal((await onRequest(context(cleanup, env))).status, 202);
});

test("rollback refuses to overwrite a resource changed after the source operation", async () => {
  const db = statefulCalendarDb();
  const resourceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const operationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const timestamp = new Date().toISOString();
  db.resources.set(resourceId, {
    id: resourceId, kind: "client", version: 2, state: "active", owner_person_id: PERSON_ID,
    data_json: JSON.stringify({ id: resourceId, name: "Newer value" }), archived: 0,
    created_at: timestamp, updated_at: timestamp,
  });
  db.operations.set(operationId, {
    id: operationId, action: "updateClient", idempotency_key: "older-operation-key",
    request_hash: "hash", trace_id: TRACE_ID, requester_person_id: PERSON_ID,
    requester_role: "admin", status: "succeeded",
    resource_refs_json: JSON.stringify([{ kind: "client", id: resourceId, version: 1 }]),
    steps_json: "[]", rollback_json: JSON.stringify({ available: true }),
    before_json: JSON.stringify({ state: "active", owner_person_id: PERSON_ID, data_json: JSON.stringify({ id: resourceId, name: "Old value" }), archived: 0 }),
    after_json: null, created_at: timestamp, completed_at: timestamp,
  });
  const request = new Request(`https://preview.example/api/simon/v3/operations/${operationId}/rollback`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "stale-rollback-guard-0001" }),
    body: JSON.stringify({ actor, reason: "attempt stale rollback", data: {} }),
  });
  const response = await onRequest(context(request, { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: "staging-token" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "version_conflict");
  assert.equal(db.resources.get(resourceId).version, 2);
});

test("file intake accepts matching clean receipts and purges confirmed malware", async () => {
  const db = statefulCalendarDb();
  const timestamp = new Date().toISOString();
  const bookingId = "12121212-1212-4212-8212-121212121212";
  const fileId = "13131313-1313-4313-8313-131313131313";
  db.resources.set(bookingId, {
    id: bookingId, kind: "booking", version: 1, state: "booked", owner_person_id: PERSON_ID,
    data_json: JSON.stringify({ id: bookingId, owner_person_id: PERSON_ID }), archived: 0,
    created_at: timestamp, updated_at: timestamp,
  });
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      objects.set(key, { value: new Uint8Array(value), options, etag: "private-r2-etag" });
      return { key, etag: "private-r2-etag" };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.value.byteLength, etag: object.etag } : null;
    },
    async delete(key) { objects.delete(key); },
  };
  const bytes = new TextEncoder().encode("harmless synthetic staging text");
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const request = new Request("https://preview.example/api/simon/v3/files/intakes", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "file-quarantine-receipt-0001" }),
    body: JSON.stringify({ actor, reason: "quarantine a synthetic file", data: {
      id: fileId, owner_person_id: PERSON_ID, target_record_kind: "booking",
      target_record_id: bookingId, filename: "synthetic-note.txt", declared_media_type: "text/plain",
      content_base64: Buffer.from(bytes).toString("base64"), checksum_sha256: checksum,
    } }),
  });
  const env = { APPLICATIONS_DB: db, APPLICATION_UPLOADS: bucket, SIMON_V3_SERVICE_TOKEN: "staging-token" };
  const response = await onRequest(context(request, env));
  assert.equal(response.status, 202);
  const stored = db.resources.get(fileId);
  assert.equal(stored.state, "quarantined");
  assert.equal(JSON.parse(stored.data_json).scan_state, "pending");
  assert.equal(JSON.parse(stored.data_json).usable, false);
  assert.equal(objects.size, 1);

  const read = new Request(`https://preview.example/api/simon/v3/files/${fileId}`, {
    headers: headers({ "x-simon-role": "client" }),
  });
  const metadata = await onRequest(context(read, env));
  assert.equal(metadata.status, 200);
  const body = await metadata.json();
  assert.equal(body.data.scan_state, "pending");
  assert.equal(body.data.usable, false);
  assert.equal("private_storage_ref" in body.data, false);

  const wrongReceipt = new Request(`https://preview.example/api/simon/v3/files/${fileId}/scan-results`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "idempotency-key": "file-scan-wrong-checksum-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({ actor, reason: "reject a mismatched scan receipt", data: {
      scanner: "clamav", scanner_version: "1.5.4", signature_version: "daily-28153",
      checksum_sha256: "0".repeat(64), verdict: "clean", scanned_at: timestamp,
    } }),
  });
  const wrongResponse = await onRequest(context(wrongReceipt, env));
  assert.equal(wrongResponse.status, 409);
  assert.equal(JSON.parse(db.resources.get(fileId).data_json).scan_state, "pending");

  const cleanReceipt = new Request(`https://preview.example/api/simon/v3/files/${fileId}/scan-results`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "idempotency-key": "file-scan-clean-receipt-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({ actor, reason: "record a matching ClamAV scan receipt", data: {
      scanner: "clamav", scanner_version: "1.5.4", signature_version: "daily-28153",
      checksum_sha256: checksum, verdict: "clean", scanned_at: "2026-01-31T12:00:00.000Z",
    } }),
  });
  const cleanResponse = await onRequest(context(cleanReceipt, env));
  assert.equal(cleanResponse.status, 202);
  const scanned = db.resources.get(fileId);
  assert.equal(scanned.version, 2);
  assert.equal(scanned.state, "ready");
  assert.equal(JSON.parse(scanned.data_json).scan_state, "clean");
  assert.equal(JSON.parse(scanned.data_json).usable, true);
  assert.equal(JSON.parse(scanned.data_json).retention_policy, "clean-private-file-6-calendar-months-v1");
  assert.equal(JSON.parse(scanned.data_json).retention_expires_at, "2026-07-31T12:00:00.000Z");
  const scanOperation = await cleanResponse.json();
  assert.equal(scanOperation.steps.at(-1).name, "malware_scan");
  assert.equal(scanOperation.steps.at(-1).provider_confirmed, true);

  const dueRequest = new Request(`https://preview.example/api/simon/v3/files/retention-due?before=${encodeURIComponent(new Date().toISOString())}`, {
    headers: headers(),
  });
  const dueResponse = await onRequest(context(dueRequest, env));
  assert.equal(dueResponse.status, 200);
  const dueBody = await dueResponse.json();
  assert.equal(dueBody.items.length, 1);
  assert.equal(dueBody.items[0].id, fileId);
  assert.equal("private_storage_ref" in dueBody.items[0].data, false);

  const expireRequest = new Request(`https://preview.example/api/simon/v3/files/${fileId}/expire`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "idempotency-key": "clean-file-retention-expiration-0001",
      "if-match": "2",
    }),
    body: JSON.stringify({ actor, reason: "apply the approved six-month clean-file retention rule", data: {} }),
  });
  const expireResponse = await onRequest(context(expireRequest, env));
  assert.equal(expireResponse.status, 202);
  const expired = db.resources.get(fileId);
  const expiredData = JSON.parse(expired.data_json);
  assert.equal(expired.version, 4);
  assert.equal(expired.state, "expired");
  assert.equal(expiredData.usable, false);
  assert.equal(expiredData.private_storage_ref, null);
  assert.equal(expiredData.retention_receipt.bytes_deleted, true);
  assert.equal(expiredData.checksum_sha256, checksum);
  assert.equal(objects.size, 0);
  const expirationOperation = await expireResponse.json();
  assert.equal(expirationOperation.steps.at(-1).name, "private_file_retention_purge");
  assert.equal(expirationOperation.steps.at(-1).provider_confirmed, true);

  const maliciousFileId = "17171717-1717-4717-8717-171717171717";
  const eicar = new TextEncoder().encode([
    "X5O!P%@AP[4\\PZX54(P^)", "7CC)7}$EICAR-STANDARD-",
    "ANTIVIRUS-TEST-FILE!$H+H*",
  ].join(""));
  const maliciousChecksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", eicar))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const maliciousIntake = new Request("https://preview.example/api/simon/v3/files/intakes", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": "file-malware-quarantine-0001" }),
    body: JSON.stringify({ actor, reason: "quarantine a synthetic antivirus fixture", data: {
      id: maliciousFileId, owner_person_id: PERSON_ID, target_record_kind: "booking",
      target_record_id: bookingId, filename: "synthetic-antivirus-fixture.txt",
      declared_media_type: "text/plain", content_base64: Buffer.from(eicar).toString("base64"),
      checksum_sha256: maliciousChecksum,
    } }),
  });
  assert.equal((await onRequest(context(maliciousIntake, env))).status, 202);
  assert.equal(objects.size, 1);

  const maliciousReceipt = new Request(`https://preview.example/api/simon/v3/files/${maliciousFileId}/scan-results`, {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "idempotency-key": "file-malware-receipt-0001",
      "if-match": "1",
    }),
    body: JSON.stringify({ actor, reason: "record and purge a confirmed malware fixture", data: {
      scanner: "clamav", scanner_version: "1.5.4", signature_version: "daily-28153",
      checksum_sha256: maliciousChecksum, verdict: "malicious", scanned_at: timestamp,
    } }),
  });
  const maliciousResponse = await onRequest(context(maliciousReceipt, env));
  assert.equal(maliciousResponse.status, 202);
  const malicious = JSON.parse(db.resources.get(maliciousFileId).data_json);
  assert.equal(malicious.scan_state, "malicious");
  assert.equal(malicious.usable, false);
  assert.equal(malicious.private_storage_ref, null);
  assert.ok(malicious.purged_at);
  assert.equal(objects.size, 0);
  const maliciousOperation = await maliciousResponse.json();
  assert.equal(maliciousOperation.steps.at(-1).name, "private_quarantine_purge");
  assert.equal(maliciousOperation.steps.at(-1).provider_confirmed, true);
});

test("retention failure revokes access before retrying private-byte deletion", async () => {
  const db = statefulCalendarDb();
  const fileId = "18181818-1818-4818-8818-181818181818";
  const storageKey = `simon-v3/quarantine/${PERSON_ID}/${fileId}/old.txt`;
  const timestamp = new Date().toISOString();
  db.resources.set(fileId, {
    id: fileId, kind: "file", version: 2, state: "ready", owner_person_id: PERSON_ID,
    data_json: JSON.stringify({
      id: fileId, scan_state: "clean", state: "ready", usable: true,
      checksum_sha256: "a".repeat(64), private_storage_ref: storageKey,
      retention_policy: "clean-private-file-6-calendar-months-v1",
      retention_expires_at: "2026-01-01T00:00:00.000Z",
    }),
    archived: 0, created_at: timestamp, updated_at: timestamp,
  });
  let stored = true;
  let failDelete = true;
  const bucket = {
    async head() { return stored ? { size: 3, etag: "old" } : null; },
    async delete() {
      if (failDelete) throw new Error("simulated deletion failure");
      stored = false;
    },
  };
  const env = { APPLICATIONS_DB: db, APPLICATION_UPLOADS: bucket, SIMON_V3_SERVICE_TOKEN: "staging-token" };
  const request = (key, version) => new Request(`https://preview.example/api/simon/v3/files/${fileId}/expire`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": key, "if-match": String(version) }),
    body: JSON.stringify({ actor, reason: "expire a due clean file", data: {} }),
  });

  const failed = await onRequest(context(request("retention-failure-safe-0001", 2), env));
  assert.equal(failed.status, 502);
  assert.equal(db.resources.get(fileId).state, "expiring");
  assert.equal(db.resources.get(fileId).version, 3);
  assert.equal(JSON.parse(db.resources.get(fileId).data_json).usable, false);
  assert.equal(stored, true);

  failDelete = false;
  const retried = await onRequest(context(request("retention-failure-retry-0002", 3), env));
  assert.equal(retried.status, 202);
  assert.equal(db.resources.get(fileId).state, "expired");
  assert.equal(db.resources.get(fileId).version, 4);
  assert.equal(stored, false);
});
