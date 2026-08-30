import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { READ_ONLY_ENDPOINTS, callSquare, squareConfig } from '../src/square.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = squareConfig({
  SQUARE_ACCESS_TOKEN: 'EAAAtoken',
  SQUARE_LOCATION_ID: 'LOC',
  SQUARE_ENVIRONMENT: 'production',
});

// Square endpoints that change seller data. None should ever be reachable.
const WRITE_ENDPOINTS = [
  '/v2/orders',
  '/v2/orders/ORDER_1',
  '/v2/orders/ORDER_1/pay',
  '/v2/catalog/object',
  '/v2/catalog/batch-upsert',
  '/v2/catalog/batch-delete',
  '/v2/payments',
  '/v2/refunds',
  '/v2/customers',
  '/v2/locations/LOC',
  '/v2/inventory/changes/batch-create',
];

test('a customer lookup is allowed; anything else under /v2/customers is not', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ customer: { email_address: 'a@b.test' } });
  try {
    // GET one customer by id: a read, needed for orders with no fulfillment.
    await callSquare(config, '/v2/customers/ABC123');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The collection endpoint creates customers, so it stays refused.
  await assert.rejects(() => callSquare(config, '/v2/customers', {}),
    /only reads from Square/);
  await assert.rejects(() => callSquare(config, '/v2/customers/ABC/cards', {}),
    /only reads from Square/);
});

test('the allowlist contains only the three reads we need', () => {
  assert.deepEqual([...READ_ONLY_ENDPOINTS].sort(), [
    '/v2/catalog/batch-retrieve',
    '/v2/locations',
    '/v2/orders/search',
  ]);
});

test('every write endpoint is refused before any request is made', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };

  try {
    for (const path of WRITE_ENDPOINTS) {
      await assert.rejects(
        () => callSquare(config, path, { anything: true }),
        /only reads from Square/,
        `${path} should be refused`,
      );
    }
    assert.equal(fetched, false, 'no request should have left the Worker');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a read endpoint with a body is a POST; without one, a GET', async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), method: options.method });
    return Response.json({});
  };

  try {
    await callSquare(config, '/v2/orders/search', { location_ids: ['LOC'] });
    await callSquare(config, '/v2/locations');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // POST here is how Square takes search criteria, not a mutation.
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[1].method, 'GET');
});

test('no source file reaches Square outside square.js', () => {
  for (const file of ['sync.js', 'index.js', 'extract.js', 'registrations.js']) {
    const source = readFileSync(join(here, '..', 'src', file), 'utf8');
    assert.doesNotMatch(source, /connect\.square/, `${file} should not name a Square host`);
    assert.doesNotMatch(source, /\/v2\//, `${file} should not name a Square endpoint`);
  }
});

test('square.js never names a mutating HTTP verb', () => {
  const source = readFileSync(join(here, '..', 'src', 'square.js'), 'utf8');
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(source, new RegExp(`['"\`]${verb}['"\`]`), `found ${verb}`);
  }
});
