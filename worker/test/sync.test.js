import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runSync } from '../src/sync.js';
import { REGISTRATION_FIELDS } from '../src/registrations.js';

/** Bound values are positional; look them up by field name, not by counting. */
const field = (values, name) => values[REGISTRATION_FIELDS.indexOf(name)];

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'square-api.json'), 'utf8'));

/** Just enough of the D1 API to record what a sync would write. */
function fakeDb() {
  const upserts = [];
  const syncLog = [];

  const statement = (sql) => ({
    sql,
    bind(...values) { return { sql, values, run: async () => ({}) }; },
    run: async () => ({}),
    first: async () => null,
    all: async () => ({ results: [] }),
  });

  return {
    upserts,
    syncLog,
    prepare(sql) {
      const built = statement(sql);
      if (sql.includes('INSERT INTO sync_log')) {
        return {
          ...built,
          bind(...values) {
            return { run: async () => { syncLog.push(values); return {}; } };
          },
        };
      }
      return built;
    },
    async batch(statements) {
      for (const s of statements) upserts.push(s.values);
      return statements.map(() => ({}));
    },
  };
}

/** Serve the fixture in place of the Square API. */
function stubSquare({ orders = fixture.orders, failWith, payments = [] } = {}) {
  const calls = [];
  const catalogById = Object.fromEntries(fixture.catalog_objects.map((o) => [o.id, o]));

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });

    if (String(url).includes('/v2/payments')) {
      return Response.json({ payments });
    }

    if (failWith) {
      return new Response(JSON.stringify({ errors: [{ detail: failWith }] }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (String(url).endsWith('/v2/orders/search')) {
      return Response.json({ orders });
    }

    if (String(url).endsWith('/v2/catalog/batch-retrieve')) {
      const ids = JSON.parse(options.body).object_ids;
      return Response.json({ objects: ids.map((id) => catalogById[id]).filter(Boolean) });
    }

    throw new Error(`unexpected request to ${url}`);
  };

  return calls;
}

const baseEnv = () => ({
  DB: fakeDb(),
  SQUARE_ACCESS_TOKEN: 'EAAAtoken',
  SQUARE_LOCATION_ID: 'LOC123',
  SQUARE_ENVIRONMENT: 'production',
  SQUARE_FETCH_LIMIT: '70',
});

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

test('a scheduled sync fetches, parses and upserts', async () => {
  const env = baseEnv();
  const calls = stubSquare();

  const result = await runSync(env);

  assert.equal(result.ok, true);
  assert.equal(result.orders, fixture.orders.length);
  assert.equal(result.upserted, 5, 'five line items across the fixture orders');
  assert.equal(env.DB.upserts.length, 5);
  assert.equal(env.DB.syncLog.length, 1, 'exactly one sync_log entry');

  const [orderSearch] = calls;
  assert.ok(orderSearch.url.includes('connect.squareup.com'), 'production host');
  assert.deepEqual(orderSearch.body.location_ids, ['LOC123']);
});

test('sandbox is a different host', async () => {
  const env = { ...baseEnv(), SQUARE_ENVIRONMENT: 'sandbox' };
  const calls = stubSquare();
  await runSync(env);
  assert.ok(calls[0].url.includes('connect.squareupsandbox.com'));
});

test('catalog reads are grouped by version, never mixed', async () => {
  const env = baseEnv();
  const calls = stubSquare();
  await runSync(env);

  const catalogCalls = calls.filter((c) => c.url.endsWith('/v2/catalog/batch-retrieve'));
  assert.ok(catalogCalls.length >= 2, 'more than one version in the fixture');
  for (const call of catalogCalls) {
    assert.ok('catalog_version' in call.body, 'every catalog read names a version');
  }
});

test('the upserted rows carry the parsed roster fields', async () => {
  const env = baseEnv();
  stubSquare();
  await runSync(env);

  // order_id, line_item_uid, campout, variation_name, name, ...
  const names = env.DB.upserts.map((values) => field(values, 'name'));
  assert.ok(names.includes('John Smith'), `expected John Smith in ${JSON.stringify(names)}`);

  const patrols = env.DB.upserts.map((values) => field(values, 'patrol'));
  assert.ok(patrols.every(Boolean), 'patrol always has a value');
  assert.ok(patrols.includes('Rocking Chair'), 'empty patrol defaults to Rocking Chair');
});

test('no orders records a sync rather than failing', async () => {
  const env = baseEnv();
  stubSquare({ orders: [] });

  const result = await runSync(env);
  assert.equal(result.ok, true);
  assert.equal(result.upserted, 0);
  assert.equal(env.DB.syncLog.length, 1);
});

test('a Square auth failure surfaces without leaking the token', async () => {
  const env = baseEnv();
  stubSquare({ failWith: 'This request could not be authorized.' });

  await assert.rejects(() => runSync(env), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /could not be authorized/);
    assert.ok(!error.message.includes('EAAAtoken'), 'the token must not appear');
    return true;
  });
});

test('missing Square config is reported, not thrown', async () => {
  const env = { ...baseEnv(), SQUARE_ACCESS_TOKEN: '' };
  const result = await runSync(env);
  assert.equal(result.ok, false);
  assert.match(result.error, /SQUARE_ACCESS_TOKEN/);
});

test('the buyer email comes from the payment, not the order', async () => {
  // Square records the email typed on the final checkout page against the
  // Payment; the Order never sees it.
  const env = baseEnv();
  const calls = stubSquare({
    payments: [
      { order_id: 'ORDER_3', buyer_email_address: 'buyer@example.com' },
      { order_id: 'ORDER_4', buyer_email_address: 'other@example.com' },
    ],
  });

  await runSync(env);

  const byOrder = Object.fromEntries(
    env.DB.upserts.map((values) => [field(values, 'order_id'), field(values, 'email')]),
  );
  assert.equal(byOrder.ORDER_3, 'buyer@example.com');
  assert.equal(byOrder.ORDER_4, 'other@example.com');

  // The fixture's own fulfillment emails must still win over the payment.
  assert.equal(byOrder.ORDER_1, 'john.smith@example.com');

  const paymentCalls = calls.filter((c) => c.url.includes('/v2/payments'));
  assert.equal(paymentCalls.length, 1, 'one listing covers the whole batch');
  assert.match(paymentCalls[0].url, /location_id=LOC123/);
  assert.match(paymentCalls[0].url, /begin_time=/, 'scoped to the oldest order fetched');
});

test('a payments failure leaves emails blank rather than failing the sync', async () => {
  const env = baseEnv();
  const catalogById = Object.fromEntries(fixture.catalog_objects.map((o) => [o.id, o]));

  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/v2/payments')) {
      return new Response(JSON.stringify({ errors: [{ detail: 'nope' }] }), { status: 403 });
    }
    if (String(url).endsWith('/v2/orders/search')) return Response.json({ orders: fixture.orders });
    const ids = JSON.parse(options.body).object_ids;
    return Response.json({ objects: ids.map((id) => catalogById[id]).filter(Boolean) });
  };

  const result = await runSync(env);
  assert.equal(result.ok, true, 'the sync still completes');
  assert.equal(result.upserted, 5);
});

test('payments are not requested when every order already has an email', async () => {
  const env = baseEnv();
  const withEmail = fixture.orders.map((order) => ({
    ...order,
    fulfillments: [{ pickup_details: { recipient: { email_address: 'a@b.test' } } }],
  }));
  const calls = stubSquare({ orders: withEmail });

  await runSync(env);
  assert.equal(calls.filter((c) => c.url.includes('/v2/payments')).length, 0);
});
