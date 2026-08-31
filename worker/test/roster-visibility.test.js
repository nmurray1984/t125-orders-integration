/**
 * The roster only shows registrations that were paid for.
 *
 * Square creates an order when the buyer reaches checkout, so an abandoned one
 * is a real order carrying real answers -- it has to be filtered out at read
 * time rather than never stored, because a checkout paid for later must be
 * able to come back.
 *
 * These run against real SQLite rather than a stubbed database: the filtering
 * lives in SQL, so a fake that answers every query the same way would prove
 * nothing. It also means schema.sql itself is exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from '../src/index.js';
import { REGISTRATION_FIELDS, upsertRows } from '../src/registrations.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

/** The slice of the D1 binding the Worker actually uses, over node:sqlite. */
function d1(database) {
  const prepare = (sql, params = []) => ({
    bind: (...values) => prepare(sql, values),
    first: async () => database.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params) }),
    run: async () => database.prepare(sql).run(...params),
  });

  return {
    prepare,
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  };
}

/** One registration row, defaulting everything the test does not care about. */
function insert(database, overrides) {
  const row = {
    campout: 'Scout Registration - NASA Campout',
    name: 'Someone',
    patrol: 'Eagle',
    payment_status: '',
    order_created_at: '2026-08-01T12:00:00Z',
    ...overrides,
  };
  const columns = REGISTRATION_FIELDS.join(', ');
  const placeholders = REGISTRATION_FIELDS.map(() => '?').join(', ');
  database
    .prepare(`INSERT INTO registrations (${columns}) VALUES (${placeholders})`)
    .run(...REGISTRATION_FIELDS.map((field) => row[field] ?? ''));
}

function seeded() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);

  insert(database, { order_id: 'PAID_1', line_item_uid: 'L1', name: 'Paid Scout', payment_status: 'PAID' });
  insert(database, { order_id: 'UNPAID_1', line_item_uid: 'L1', name: 'Abandoned Scout', payment_status: 'UNPAID' });
  insert(database, { order_id: 'CANCELED_1', line_item_uid: 'L1', name: 'Canceled Scout', payment_status: 'CANCELED' });
  // Synced before the column existed: unknown, and therefore still visible.
  insert(database, { order_id: 'LEGACY_1', line_item_uid: 'L1', name: 'Legacy Scout' });

  database.prepare("INSERT INTO sync_log (synced_at, rows_seen) VALUES ('2026-08-01T13:00:00Z', 4)").run();

  return {
    database,
    DB: d1(database),
    SESSION_SECRET: 'secret',
    TROOP_PASSWORD: 'pw',
    SYNC_TOKEN: 'tok',
  };
}

async function signIn(env) {
  const response = await worker.fetch(
    new Request('https://roster.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    }),
    env,
  );
  return response.headers.get('Set-Cookie').split(';')[0];
}

const get = (env, cookie, path) =>
  worker.fetch(new Request(`https://roster.test${path}`, { headers: { Cookie: cookie } }), env);

test('the roster hides unpaid and canceled registrations', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const body = await (await get(env, cookie, '/api/roster')).json();
  const names = body.rows.map((row) => row.name).sort();

  assert.deepEqual(names, ['Legacy Scout', 'Paid Scout']);
  assert.equal(body.headcount, 2, 'the headcount counts only what is shown');
});

test('an unknown status stays visible, so nothing synced before this vanishes', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const body = await (await get(env, cookie, '/api/roster')).json();
  assert.ok(body.rows.some((row) => row.order_id === 'LEGACY_1'));
});

test('filtering a single campout hides them too', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const campout = encodeURIComponent('Scout Registration - NASA Campout');
  const body = await (await get(env, cookie, `/api/roster?campout=${campout}`)).json();

  assert.deepEqual(body.rows.map((row) => row.name).sort(), ['Legacy Scout', 'Paid Scout']);
});

test('patrol headcounts do not count people who never paid', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const body = await (await get(env, cookie, '/api/roster')).json();
  const eagle = body.patrols.find((p) => p.patrol === 'Eagle');
  assert.equal(eagle.headcount, 2, 'two of the four rows are visible');
});

test('the roster reports how many are withheld, so nobody looks lost', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const all = await (await get(env, cookie, '/api/roster')).json();
  assert.equal(all.unpaid, 2, 'the unpaid and the canceled one');

  const campout = encodeURIComponent('Scout Registration - NASA Campout');
  const filtered = await (await get(env, cookie, `/api/roster?campout=${campout}`)).json();
  assert.equal(filtered.unpaid, 2, 'counted within the campout being viewed');
});

test('the campout list counts only paid registrations', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const body = await (await get(env, cookie, '/api/campouts')).json();
  assert.equal(body.campouts.length, 1);
  assert.equal(body.campouts[0].registrations, 2);
});

test('the CSV export leaves them out as well', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  const csv = await (await get(env, cookie, '/api/export.csv')).text();
  assert.match(csv, /Paid Scout/);
  assert.doesNotMatch(csv, /Abandoned Scout/);
  assert.doesNotMatch(csv, /Canceled Scout/);
});

test('the filter survives a campout mapped from several registration types', async () => {
  // The campout name is resolved through two LEFT JOINs. Filtering there must
  // not multiply the rows or lose the ones that map cleanly.
  const env = seeded();
  const cookie = await signIn(env);

  env.database.prepare("INSERT INTO campouts (id, name) VALUES (1, 'NASA Campout')").run();
  env.database.prepare(
    `INSERT INTO registration_types (line_item_name, campout_id)
     VALUES ('Scout Registration - NASA Campout', 1), ('Scouter Registration - NASA Campout', 1)`,
  ).run();
  insert(env.database, {
    order_id: 'PAID_2',
    line_item_uid: 'L1',
    campout: 'Scouter Registration - NASA Campout',
    name: 'Paid Scouter',
    payment_status: 'PAID',
  });
  insert(env.database, {
    order_id: 'UNPAID_3',
    line_item_uid: 'L1',
    campout: 'Scouter Registration - NASA Campout',
    name: 'Abandoned Scouter',
    payment_status: 'UNPAID',
  });

  const body = await (await get(env, cookie, '/api/roster?campout=NASA%20Campout')).json();
  assert.deepEqual(
    body.rows.map((row) => row.name).sort(),
    ['Legacy Scout', 'Paid Scout', 'Paid Scouter'],
    'both registration types, neither duplicated, no unpaid ones',
  );
  assert.equal(body.unpaid, 3);

  const campouts = await (await get(env, cookie, '/api/campouts')).json();
  const nasa = campouts.campouts.find((c) => c.campout === 'NASA Campout');
  assert.equal(nasa.registrations, 3);
  assert.equal(nasa.registration_types, 2);
});

test('a campout whose signups were all abandoned still appears', async () => {
  // The case the roster note exists for. If the campout dropped out of the
  // list it would not be selectable, and the explanation would be unreachable
  // exactly when somebody is asking where everyone went.
  const env = seeded();
  const cookie = await signIn(env);

  insert(env.database, {
    order_id: 'UNPAID_4',
    line_item_uid: 'L1',
    campout: 'Scout Registration - Ghost Campout',
    name: 'Abandoned Only',
    payment_status: 'UNPAID',
  });

  const body = await (await get(env, cookie, '/api/campouts')).json();
  const ghost = body.campouts.find((c) => c.campout === 'Scout Registration - Ghost Campout');

  assert.ok(ghost, 'the campout is still listed');
  assert.equal(ghost.registrations, 0, 'but nobody is counted as signed up');
  assert.equal(ghost.unpaid, 1);

  // And selecting it explains itself rather than looking broken.
  const campout = encodeURIComponent('Scout Registration - Ghost Campout');
  const roster = await (await get(env, cookie, `/api/roster?campout=${campout}`)).json();
  assert.equal(roster.rows.length, 0);
  assert.equal(roster.unpaid, 1);
});

test('the campout list still dates itself from every order, paid or not', async () => {
  // last_order_at feeds the "no parseable date" ordering in campouts.js.
  // Filtering it by payment would shift which campout opens by default.
  const env = seeded();
  const cookie = await signIn(env);

  insert(env.database, {
    order_id: 'UNPAID_5',
    line_item_uid: 'L1',
    name: 'Latest But Unpaid',
    payment_status: 'UNPAID',
    order_created_at: '2026-09-30T12:00:00Z',
  });

  const body = await (await get(env, cookie, '/api/campouts')).json();
  const nasa = body.campouts.find((c) => c.campout === 'Scout Registration - NASA Campout');
  assert.equal(nasa.last_order_at, '2026-09-30T12:00:00Z');
});

test('a later sync cannot demote a row that was confirmed paid', async () => {
  // The CLI backfill never reads the payments listing, and the Worker's own
  // listing is a bounded walk -- so both can report a bare UNPAID for an order
  // that really was paid. Neither may hide it.
  const env = seeded();

  const row = (overrides) => {
    const base = Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f, '']));
    return { ...base, order_id: 'RESCUED', line_item_uid: 'L1', name: 'Rescued Scout', ...overrides };
  };

  await upsertRows(env, [row({ payment_status: 'PAID' })], '2026-08-01T00:00:00Z');
  await upsertRows(env, [row({ payment_status: 'UNPAID' })], '2026-08-02T00:00:00Z');

  const stored = env.database
    .prepare("SELECT payment_status, synced_at FROM registrations WHERE order_id = 'RESCUED'")
    .get();
  assert.equal(stored.payment_status, 'PAID', 'absence of evidence does not beat evidence');
  assert.equal(stored.synced_at, '2026-08-02T00:00:00Z', 'the rest of the row still updates');
});

test('an explicit cancellation does overwrite a stored PAID', async () => {
  const env = seeded();

  const row = (overrides) => {
    const base = Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f, '']));
    return { ...base, order_id: 'DROPPED', line_item_uid: 'L1', ...overrides };
  };

  await upsertRows(env, [row({ payment_status: 'PAID' })], '2026-08-01T00:00:00Z');
  await upsertRows(env, [row({ payment_status: 'CANCELED' })], '2026-08-02T00:00:00Z');

  const stored = env.database
    .prepare("SELECT payment_status FROM registrations WHERE order_id = 'DROPPED'")
    .get();
  assert.equal(stored.payment_status, 'CANCELED', 'a cancellation is evidence, not a gap');
});

test('an abandoned checkout does not conjure a registration type to configure', async () => {
  const env = seeded();
  const cookie = await signIn(env);

  // A registration type nobody has ever paid for. Nothing of it reaches the
  // roster, so there is nothing to map onto a campout either.
  insert(env.database, {
    order_id: 'UNPAID_2',
    line_item_uid: 'L1',
    campout: 'Scouter Registration - Phantom Campout',
    payment_status: 'UNPAID',
  });

  const body = await (await get(env, cookie, '/api/setup')).json();
  const names = body.registration_types.map((t) => t.line_item_name);

  assert.deepEqual(names, ['Scout Registration - NASA Campout']);
  assert.equal(body.registration_types[0].registrations, 2, 'the hidden rows are not counted');
});
