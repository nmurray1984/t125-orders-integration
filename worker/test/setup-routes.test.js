import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

/**
 * Enough of D1 to exercise the setup routes' request handling. The point here
 * is the HTTP layer -- method routing, body handling, auth -- not SQL.
 */
function fakeDb(rows = {}) {
  const respond = (sql) => {
    if (/FROM campouts WHERE id/.test(sql)) return rows.campout ?? { id: 1 };
    if (/FROM registrations WHERE campout/.test(sql)) return rows.seen ?? { ok: 1 };
    return null;
  };

  const make = (sql) => ({
    bind: () => make(sql),
    first: async () => respond(sql),
    run: async () => ({}),
    all: async () => ({ results: [] }),
  });

  return { prepare: make, batch: async (s) => s.map(() => ({})) };
}

const env = () => ({
  DB: fakeDb(),
  SESSION_SECRET: 'secret',
  TROOP_PASSWORD: 'pw',
  SYNC_TOKEN: 'tok',
});

async function signedInCookie(environment) {
  const response = await worker.fetch(
    new Request('https://roster.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    }),
    environment,
  );
  return response.headers.get('Set-Cookie').split(';')[0];
}

const call = (environment, cookie, path, init = {}) =>
  worker.fetch(new Request(`https://roster.test${path}`, {
    ...init,
    // After the spread, or init.headers would clobber the cookie.
    headers: cookie ? { Cookie: cookie, ...(init.headers || {}) } : init.headers,
  }), environment);

test('setup requires a session', async () => {
  const environment = env();
  const response = await call(environment, null, '/api/setup');
  assert.equal(response.status, 401);
});

test('DELETE works without a request body', async () => {
  // A DELETE carries no body; demanding JSON from it rejected every delete.
  const environment = env();
  const cookie = await signedInCookie(environment);
  const response = await call(environment, cookie, '/api/setup/campouts/1', { method: 'DELETE' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('POST with a malformed body is rejected as such', async () => {
  const environment = env();
  const cookie = await signedInCookie(environment);
  const response = await call(environment, cookie, '/api/setup/campouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /invalid JSON/);
});

test('an unknown setup path is a 404, not a 500', async () => {
  const environment = env();
  const cookie = await signedInCookie(environment);
  const response = await call(environment, cookie, '/api/setup/nonsense', { method: 'DELETE' });
  assert.equal(response.status, 404);
});

test('a campout id must be numeric', async () => {
  const environment = env();
  const cookie = await signedInCookie(environment);
  const response = await call(environment, cookie, '/api/setup/campouts/abc', { method: 'DELETE' });
  assert.equal(response.status, 404);
});
