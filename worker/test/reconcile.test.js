/**
 * scripts/reconcile.mjs: the comparison and the SQL it writes.
 *
 * The SQL runs against real SQLite built from schema.sql, so a statement that
 * D1 would reject, or one that clobbers first_seen_at, fails here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildSql, compare, parseArgs } from '../scripts/reconcile.mjs';
import { REGISTRATION_FIELDS } from '../src/registrations.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

function row(overrides = {}) {
  const base = Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f, '']));
  return {
    ...base,
    order_id: 'O1',
    line_item_uid: 'L1',
    campout: 'Scout Registration - Fall Campout',
    name: 'Alex',
    scout_name: 'Alex',
    patrol: 'Eagles',
    payment_status: 'PAID',
    order_created_at: '2026-09-01T00:00:00Z',
    email: 'a@example.com',
    ...overrides,
  };
}

const keyed = (...rows) => new Map(rows.map((r) => [`${r.order_id}\u0000${r.line_item_uid}`, r]));

test('identical rows match; D1-only columns are ignored', () => {
  const plan = compare(keyed(row()), keyed({ ...row(), first_seen_at: 'x', synced_at: 'y' }));
  assert.equal(plan.matched, 1);
  assert.equal(plan.changed.length + plan.missing.length + plan.orphans.length, 0);
});

test('rows Square has and D1 lacks are missing', () => {
  const plan = compare(keyed(row(), row({ line_item_uid: 'L2' })), keyed(row()));
  assert.deepEqual(plan.missing.map((r) => r.line_item_uid), ['L2']);
});

test('field drift is reported per column', () => {
  const plan = compare(keyed(row({ payment_status: 'REFUNDED', rank: 'Star' })), keyed(row()));
  assert.equal(plan.changed.length, 1);
  assert.deepEqual(
    plan.changed[0].diffs.map((d) => [d.field, d.from, d.to]),
    [['rank', '', 'Star'], ['payment_status', 'PAID', 'REFUNDED']],
  );
});

test('PAID -> UNPAID is held back unless --allow-demote', () => {
  const square = keyed(row({ payment_status: 'UNPAID' }));
  const d1 = keyed(row());

  const held = compare(square, d1);
  assert.equal(held.heldDemotions.length, 1);
  assert.equal(held.changed.length, 0);

  const allowed = compare(square, d1, { allowDemote: true });
  assert.equal(allowed.heldDemotions.length, 0);
  assert.equal(allowed.changed[0].row.payment_status, 'UNPAID');
  assert.equal(allowed.changed[0].diffs[0].demotion, true);
});

test('an email Square could not find is never blanked out', () => {
  const plan = compare(keyed(row({ email: '' })), keyed(row()));
  assert.equal(plan.matched, 1);
  assert.equal(plan.keptEmails.length, 1);
});

test('orphans say whether the order or just the line item is gone', () => {
  const d1 = keyed(row(), row({ line_item_uid: 'OLD' }), row({ order_id: 'GONE' }));
  const plan = compare(keyed(row()), d1, { orderIds: new Set(['O1']) });
  assert.deepEqual(
    plan.orphans.map((o) => [o.row.order_id, o.row.line_item_uid, o.reason]),
    [['O1', 'OLD', 'line item no longer on order'], ['GONE', 'L1', 'order not in Square']],
  );
});

test('--since keeps rows older than the window out of the orphan check', () => {
  const d1 = keyed(row({ order_id: 'OLD', order_created_at: '2025-01-01T00:00:00Z' }));
  const plan = compare(new Map(), d1, { orderIds: new Set(), since: '2026-01-01' });
  assert.equal(plan.orphans.length, 0);
});

test('the generated SQL inserts, updates in place, keeps first_seen_at, and deletes only on request', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);

  const cols = [...REGISTRATION_FIELDS, 'first_seen_at', 'synced_at'];
  const insert = db.prepare(`INSERT INTO registrations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const put = (r) => insert.run(...REGISTRATION_FIELDS.map((f) => r[f]), 'first', 'first');
  put(row());
  put(row({ order_id: 'GONE' }));

  const square = keyed(
    row({ payment_status: 'REFUNDED', scout_name: "O'Brien", name: "O'Brien" }),
    row({ order_id: 'NEW' }),
  );
  const d1 = new Map(db.prepare('SELECT * FROM registrations').all()
    .map((r) => [`${r.order_id}\u0000${r.line_item_uid}`, r]));
  const plan = compare(square, d1, { orderIds: new Set(['O1', 'NEW']) });

  const keep = buildSql(plan, { now: 'now' });
  assert.equal(keep.length, 2);
  db.exec(keep.join('\n'));

  const get = (id) => db.prepare('SELECT * FROM registrations WHERE order_id = ?').get(id);
  assert.equal(get('O1').payment_status, 'REFUNDED');
  assert.equal(get('O1').name, "O'Brien");
  assert.equal(get('O1').first_seen_at, 'first');
  assert.equal(get('O1').synced_at, 'now');
  assert.equal(get('NEW').first_seen_at, 'now');
  assert.ok(get('GONE'), 'orphans are kept by default');

  db.exec(buildSql({ ...plan, missing: [], changed: [] }, { now: 'now', deleteOrphans: true }).join('\n'));
  assert.equal(get('GONE'), undefined);
});

test('remote defaults to production Square, local to sandbox', () => {
  assert.equal(parseArgs([]).squareEnv, 'production');
  assert.equal(parseArgs(['--local']).squareEnv, 'sandbox');
  assert.equal(parseArgs(['--local', '--square-env', 'production']).squareEnv, 'production');
  assert.throws(() => parseArgs(['--square-env', 'prod']));
  assert.throws(() => parseArgs(['--since', 'not-a-date']));
  assert.throws(() => parseArgs(['--bogus']));
});
