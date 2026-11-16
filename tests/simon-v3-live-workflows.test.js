import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { onRequest } from '../functions/api/simon/v3/[[path]].js';

const APP = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const actor = { person_id: CLIENT, role: 'admin', authority_grant_id: APP };
function database() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations', import.meta.url)).sort()) {
    sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  return {
    sql,
    prepare(query) {
      const statement = sql.prepare(query);
      return {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { return statement.get(...this.values) || null; },
        async all() { return { results: statement.all(...this.values) }; },
        async run() { const result = statement.run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const out = []; for (const statement of statements) out.push(await statement.run()); sql.exec('COMMIT'); return out; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
}
function seed(db) {
  db.sql.prepare(`INSERT INTO applications (id, created_at, status, category, service, service_option,
    preferred_date, preferred_time, first_name, last_name, artist_name, email, phone, google_event_id)
    VALUES (?, '2026-11-01T00:00:00Z', 'new', 'recording', 'Vocal Recording Session', '3 hours',
      '2027-11-29', '7:00 PM', 'Example', 'Client', 'Example Artist', 'client@example.test', '5555550100', 'request-event')`).run(APP);
}
async function call(db, path, data, key = crypto.randomUUID(), extraEnv = {}) {
  const headers = { authorization: 'Bearer test-token', 'x-simon-person-id': CLIENT,
    'x-simon-role': 'admin', 'x-simon-authority-grant-id': APP, 'x-simon-trace-id': APP };
  const request = new Request(`https://example.test/api/simon/v3${path}`, data === undefined ? { headers }
    : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ actor, reason: 'Explicit owner request', data }) });
  return onRequest({ request, env: { APPLICATIONS_DB: db, SIMON_V3_SERVICE_TOKEN: 'test-token', ...extraEnv }, waitUntil() {} });
}

test('live archival hides old applications, preserves paid history and restores idempotently', async () => {
  const db = database(); seed(db);
  db.sql.prepare("UPDATE applications SET status = 'confirmed', deposit_status = 'paid', deposit_amount_paid_cents = 7000 WHERE id = ?").run(APP);
  const key = crypto.randomUUID();
  assert.equal((await call(db, `/applications/${APP}/archive`, {}, key)).status, 202);
  assert.equal((await call(db, `/applications/${APP}/archive`, {}, key)).status, 202);
  const row = db.sql.prepare('SELECT * FROM applications WHERE id = ?').get(APP);
  assert.equal(row.status, 'confirmed'); assert.equal(row.deposit_amount_paid_cents, 7000); assert.ok(row.archived_at);
  assert.equal((await (await call(db, '/applications')).json()).items.length, 0);
  assert.equal((await call(db, `/applications/${APP}/restore`, {})).status, 202);
  assert.equal((await (await call(db, '/applications')).json()).items.length, 1);
});

test('live contact search and outreach claim resolve the same client and cannot send twice', async () => {
  const db = database(); seed(db);
  db.sql.prepare("UPDATE applications SET status = 'approved' WHERE id = ?").run(APP);
  assert.equal((await (await call(db, '/clients/search?query=Example%20Client')).json()).exact_matches.length, 1);
  const queued = await (await call(db, '/notifications', {
    recipient_person_id: APP, channel: 'sms', template: 'client_outreach',
    dedupe_key: 'explicit-outreach-test', variables: { message: 'Ready to book another session?' },
  })).json();
  const id = queued.resource_refs[0].id;
  assert.equal((await (await call(db, '/notifications/pending')).json()).items.length, 1);
  const claim = await (await call(db, `/notifications/${id}/claim`, {})).json();
  assert.equal(claim.data.phone, '+15555550100');
  assert.equal((await call(db, `/notifications/${id}/claim`, {})).status, 409);
  assert.equal((await call(db, `/notifications/${id}/delivery`, { claim_id: claim.data.claim_id, provider_receipt: 'apple-receipt' })).status, 200);
  assert.equal((await (await call(db, '/notifications/pending')).json()).items.length, 0);
  assert.equal((await (await call(db, `/notifications/${id}`)).json()).data.state, 'delivered');
});

test('live approval updates native application, calendar and payment page once, with an email receipt', async t => {
  const db = database(); seed(db);
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let emails = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'test' }));
    if (String(url).endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { test: { busy: [] } } }));
    if (String(url).includes('/events/request-event')) {
      assert.equal(options.method, 'PATCH');
      assert.equal(JSON.parse(options.body).transparency, 'opaque');
      return new Response(JSON.stringify({ id: 'request-event', status: 'confirmed' }));
    }
    if (String(url).includes('gmail.googleapis.com')) { emails++; return new Response(JSON.stringify({ id: 'email-receipt' })); }
    throw new Error(`Unexpected provider ${url}`);
  };
  const env = { GOOGLE_CALENDAR_ID: 'test', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@example.test',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey, GOOGLE_EMAIL_IMPERSONATED_USER: 'test@example.test' };
  const data = { summary: 'Session', service_id: 'vocal-recording', starts_at: '2027-11-30T01:00:00Z',
    ends_at: '2027-11-30T04:00:00Z', agreed_total_minor: 21000, deposit_amount_minor: 7000, currency: 'USD' };
  const key = crypto.randomUUID();
  const response = await call(db, `/applications/${APP}/approve-with-deposit`, data, key, env);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'succeeded');
  assert.equal((await call(db, `/applications/${APP}/approve-with-deposit`, data, key, env)).status, 202);
  const row = db.sql.prepare('SELECT * FROM applications WHERE id = ?').get(APP);
  assert.equal(row.status, 'approved'); assert.equal(row.deposit_status, 'pending');
  assert.equal(row.agreed_total_minor, 21000); assert.equal(row.deposit_amount_cents, 7000);
  assert.equal(row.google_event_id, 'request-event'); assert.equal(row.decision_email_status, 'sent'); assert.equal(emails, 1);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM simon_v3_resources WHERE kind IN ('application', 'booking')").get().n, 0);
});
