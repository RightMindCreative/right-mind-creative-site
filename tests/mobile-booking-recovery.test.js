import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestGet as health } from '../functions/api/simon/mobile-health.js';
import { onRequestGet as history } from '../functions/api/simon/applications.js';

test('mobile credential is accepted without changing Simon credentials', async () => {
  const env = { RMC_CLIENT_SERVICE_TOKEN: 'mobile-fixture', SIMON_SERVICE_TOKEN: 'simon-fixture',
    APPLICATIONS_DB: { prepare: () => ({ first: async () => ({ ready: 1 }) }) } };
  for (const token of ['mobile-fixture', 'simon-fixture']) {
    const response = await health({ env, request: new Request('https://fixture/api/simon/mobile-health', {
      headers: { Authorization: `Bearer ${token}` },
    }) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.contract, 'rmc-mobile-booking-v1');
    assert.doesNotMatch(JSON.stringify(payload), /fixture/);
  }
  const denied = await health({ env, request: new Request('https://fixture/api/simon/mobile-health') });
  assert.equal(denied.status, 401);
});

test('history filters the client in SQL before applying the result limit', async () => {
  let sql, bindings;
  const env = { RMC_CLIENT_SERVICE_TOKEN: 'mobile-fixture', APPLICATIONS_DB: {
    prepare(query) { sql = query; return { bind(...args) { bindings = args; return this; },
      async all() { return { results: [{ id: 'mine', email: 'me@example.com' }, { id: 'other', email: 'other@example.com' }] }; } }; },
  } };
  const response = await history({ env, request: new Request('https://fixture/api/simon/applications?email=me%40example.com', {
    headers: { Authorization: 'Bearer mobile-fixture' },
  }) });
  assert.match(sql, /WHERE[\s\S]+ORDER BY[\s\S]+LIMIT 100/);
  assert.deepEqual(bindings, ['me@example.com', 'me@example.com', '', '']);
  assert.deepEqual((await response.json()).applications.map(x => x.id), ['mine']);
});
