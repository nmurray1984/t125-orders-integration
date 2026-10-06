/**
 * Fully reconcile Square against the D1 roster.
 *
 * The hourly cron only ever looks at the newest SQUARE_FETCH_LIMIT orders and
 * walks at most 10 pages of payments, so anything it got wrong about an older
 * order -- a missed sync, a refund issued after the order scrolled out of the
 * window, a payment it never reached -- stays wrong forever. This script walks
 * the location's ENTIRE order and payment history, parses it with the exact
 * code the Worker runs (src/extract.js, src/payments.js, src/sync.js), and
 * compares the result row by row with what D1 holds.
 *
 * Dry run by default: it prints a report and writes it to .reconcile/. Nothing
 * is changed unless --apply is given, and even then two kinds of change need
 * their own flag because they can remove someone from the roster:
 *
 *   --allow-demote     let a stored PAID become UNPAID. The cron never does
 *                      this (see PAYMENT_STATUS_MERGE in registrations.js);
 *                      a full payments walk is much stronger evidence than the
 *                      cron's, but still review these by hand first.
 *   --delete-orphans   delete D1 rows Square no longer returns at all.
 *
 * Usage (from worker/):
 *
 *   node scripts/reconcile.mjs                      # remote D1 vs production Square, report only
 *   node scripts/reconcile.mjs --apply              # write the safe fixes
 *   node scripts/reconcile.mjs --apply --allow-demote --delete-orphans
 *   node scripts/reconcile.mjs --since 2026-01-01   # only orders created on/after a date
 *   node scripts/reconcile.mjs --local --square-env sandbox
 *
 * Credentials:
 *   Square      SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID (or the SQUARE_SANDBOX_*
 *               pair for --square-env sandbox), from the environment, ../.env,
 *               or .dev.vars -- the same variables the CLI and Worker use.
 *   Cloudflare  whatever wrangler already uses: `npx wrangler login`, or
 *               CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 *
 * Square access is read-only: every call goes through callSquare(), which
 * enforces ALLOWED_REQUESTS in src/square.js.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractRows, modifierIdsByVersion, modifierListIdsByVersion } from '../src/extract.js';
import { PAID, UNPAID } from '../src/payments.js';
import { REGISTRATION_FIELDS, buildRegistration, normalizeRow } from '../src/registrations.js';
import { callSquare, fetchCatalogObjects, fetchPayments, squareConfig } from '../src/square.js';
import { confirmPayments, fillMissingEmails } from '../src/sync.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 't125-roster';
const D1_PAGE_SIZE = 1000;

/** Fields compared between Square and D1: everything but the key. */
export const COMPARED_FIELDS = REGISTRATION_FIELDS.filter(
  (field) => field !== 'order_id' && field !== 'line_item_uid',
);

const keyOf = (row) => `${row.order_id}\u0000${row.line_item_uid}`;

// ---------------------------------------------------------------------------
// Arguments and credentials
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    target: '--remote',
    squareEnv: null,
    since: null,
    apply: false,
    allowDemote: false,
    deleteOrphans: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };

    if (arg === '--local') args.target = '--local';
    else if (arg === '--remote') args.target = '--remote';
    else if (arg === '--square-env') args.squareEnv = value();
    else if (arg.startsWith('--square-env=')) args.squareEnv = arg.split('=')[1];
    else if (arg === '--since') args.since = value();
    else if (arg.startsWith('--since=')) args.since = arg.split('=')[1];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-demote') args.allowDemote = true;
    else if (arg === '--delete-orphans') args.deleteOrphans = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  // Reconciling the production database against sandbox orders would flag
  // every real registration as an orphan, so remote defaults to production
  // (what the cron uses, per wrangler.toml) and local to sandbox.
  if (!args.squareEnv) args.squareEnv = args.target === '--remote' ? 'production' : 'sandbox';
  if (!['sandbox', 'production'].includes(args.squareEnv)) {
    throw new Error(`--square-env must be sandbox or production, not ${args.squareEnv}`);
  }
  if (args.since && Number.isNaN(Date.parse(args.since))) {
    throw new Error(`--since is not a date: ${args.since}`);
  }
  return args;
}

/** Minimal KEY=value reader for .env / .dev.vars. Never overrides real env. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

/** Same resolution as Config.square_credentials() in config.py. */
function squareEnvFor(environment) {
  const env = process.env;
  let token = env.SQUARE_ACCESS_TOKEN;
  let locationId = env.SQUARE_LOCATION_ID;
  let source = 'SQUARE_ACCESS_TOKEN';

  if (environment === 'sandbox' && env.SQUARE_SANDBOX_ACCESS_TOKEN) {
    token = env.SQUARE_SANDBOX_ACCESS_TOKEN;
    locationId = env.SQUARE_SANDBOX_LOCATION_ID || locationId;
    source = 'SQUARE_SANDBOX_ACCESS_TOKEN';
  }

  const missing = [];
  if (!token) missing.push(source);
  if (!locationId) {
    missing.push(source === 'SQUARE_SANDBOX_ACCESS_TOKEN'
      ? 'SQUARE_SANDBOX_LOCATION_ID' : 'SQUARE_LOCATION_ID');
  }
  if (missing.length) throw new Error(`missing ${missing.join(' and ')} for ${environment}`);

  return {
    source,
    env: {
      SQUARE_ENVIRONMENT: environment,
      SQUARE_ACCESS_TOKEN: token.trim(),
      SQUARE_LOCATION_ID: locationId.trim(),
      SQUARE_API_VERSION: env.SQUARE_API_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// Square: the whole history, parsed exactly as the cron parses it
// ---------------------------------------------------------------------------

/** Every order at the location (optionally since a date), newest first. */
async function fetchAllOrders(config, since) {
  const orders = [];
  let cursor;

  do {
    const body = {
      location_ids: [config.locationId],
      limit: 500,
      query: {
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        ...(since ? {
          filter: { date_time_filter: { created_at: { start_at: new Date(since).toISOString() } } },
        } : {}),
      },
    };
    if (cursor) body.cursor = cursor;

    const page = await callSquare(config, '/v2/orders/search', body);
    orders.push(...(page.orders || []));
    cursor = page.cursor;
    process.stderr.write(`\r  orders fetched: ${orders.length}`);
  } while (cursor);

  process.stderr.write('\n');
  return orders;
}

/** What the roster SHOULD hold, per Square, keyed by primary key. */
async function expectedRowsFromSquare(config, since) {
  const orders = await fetchAllOrders(config, since);

  const catalogById = await fetchCatalogObjects(config, modifierIdsByVersion(orders));
  Object.assign(
    catalogById,
    await fetchCatalogObjects(config, modifierListIdsByVersion(orders, catalogById)),
  );
  const parsed = extractRows(orders, catalogById);

  // Unlike the cron, walk every payment page: this is the whole point.
  const oldest = parsed.map((row) => row.order_created_at).filter(Boolean).sort()[0];
  const paymentsByOrder = parsed.length
    ? await fetchPayments(config, oldest, { maxPages: Infinity })
    : new Map();
  console.error(`  payments matched to ${paymentsByOrder.size} order(s)`);

  confirmPayments(parsed, paymentsByOrder);
  await fillMissingEmails(config, parsed, paymentsByOrder);

  const rows = parsed.map(buildRegistration).map(normalizeRow).filter(Boolean);
  return {
    orders,
    orderIds: new Set(orders.map((order) => order.id)),
    rows: new Map(rows.map((row) => [keyOf(row), row])),
    skipped: parsed.length - rows.length,
  };
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

function wrangler(target, args, { json = false } = {}) {
  const output = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, target, '--yes', ...args, ...(json ? ['--json'] : [])],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 },
  );
  if (!json) return output;
  // wrangler can print progress before the JSON payload.
  return JSON.parse(output.slice(output.indexOf('[')));
}

function readD1Rows(target) {
  const rows = new Map();
  for (let offset = 0; ; offset += D1_PAGE_SIZE) {
    const result = wrangler(target, [
      '--command',
      `SELECT * FROM registrations ORDER BY order_id, line_item_uid LIMIT ${D1_PAGE_SIZE} OFFSET ${offset}`,
    ], { json: true });
    const page = result[0]?.results ?? [];
    for (const row of page) rows.set(keyOf(row), row);
    if (page.length < D1_PAGE_SIZE) return rows;
  }
}

// ---------------------------------------------------------------------------
// Comparison (pure; covered by test/reconcile.test.js)
// ---------------------------------------------------------------------------

const text = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Compare what Square says against what D1 holds.
 *
 * Returns the plan: which rows to insert, which to update (and how), which
 * changes are held back pending a flag, and which D1 rows Square no longer
 * knows about. `since`, when set, keeps rows older than it out of the orphan
 * check -- they were never fetched, so their absence proves nothing.
 */
export function compare(expected, actual, { orderIds, since = null, allowDemote = false } = {}) {
  const sinceIso = since ? new Date(since).toISOString() : null;
  const plan = {
    missing: [],        // in Square, not in D1 -> insert
    changed: [],        // in both, fields differ -> update
    heldDemotions: [],  // PAID in D1, UNPAID per Square, not applied without --allow-demote
    keptEmails: [],     // D1 has an email Square could not produce; kept
    orphans: [],        // in D1, not in Square
    matched: 0,
  };

  for (const [key, want] of expected) {
    const have = actual.get(key);
    if (!have) {
      plan.missing.push(want);
      continue;
    }

    const target = { ...want };
    const diffs = [];

    // A blank email from Square means every lookup came up empty this time,
    // not that the buyer has no email. Never blank one out.
    if (!want.email && text(have.email)) {
      target.email = text(have.email);
      plan.keptEmails.push({ key: want, email: target.email });
    }

    if (text(have.payment_status) === PAID && want.payment_status === UNPAID) {
      if (allowDemote) {
        diffs.push({ field: 'payment_status', from: PAID, to: UNPAID, demotion: true });
      } else {
        target.payment_status = PAID;
        plan.heldDemotions.push(want);
      }
    }

    for (const field of COMPARED_FIELDS) {
      if (field === 'payment_status' && diffs.some((d) => d.field === field)) continue;
      if (text(have[field]) !== text(target[field])) {
        diffs.push({ field, from: text(have[field]), to: text(target[field]) });
      }
    }

    if (diffs.length) plan.changed.push({ row: target, diffs });
    else plan.matched += 1;
  }

  for (const [key, have] of actual) {
    if (expected.has(key)) continue;
    if (sinceIso && !(text(have.order_created_at) >= sinceIso)) continue;
    plan.orphans.push({
      row: have,
      // The order is still there but this line item is not: usually an edited
      // order. Gone entirely: deleted, or from another location/environment.
      reason: orderIds?.has(have.order_id) ? 'line item no longer on order' : 'order not in Square',
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const sqlString = (value) => `'${text(value).replace(/'/g, "''")}'`;

/**
 * Statements that bring D1 in line with the plan.
 *
 * Unlike the cron's upsert this overwrites payment_status outright -- the plan
 * has already decided which demotions to hold back. first_seen_at is kept on
 * existing rows, as everywhere else.
 */
export function buildSql(plan, { now, deleteOrphans = false }) {
  const statements = [];
  const columns = [...REGISTRATION_FIELDS, 'first_seen_at', 'synced_at'];
  const updates = COMPARED_FIELDS.map((f) => `${f} = excluded.${f}`).concat('synced_at = excluded.synced_at');

  for (const row of [...plan.missing, ...plan.changed.map((c) => c.row)]) {
    const values = REGISTRATION_FIELDS.map((f) => sqlString(row[f])).concat(sqlString(now), sqlString(now));
    statements.push(
      `INSERT INTO registrations (${columns.join(', ')}) VALUES (${values.join(', ')}) `
      + `ON CONFLICT(order_id, line_item_uid) DO UPDATE SET ${updates.join(', ')};`,
    );
  }

  if (deleteOrphans) {
    for (const { row } of plan.orphans) {
      statements.push(
        `DELETE FROM registrations WHERE order_id = ${sqlString(row.order_id)} `
        + `AND line_item_uid = ${sqlString(row.line_item_uid)};`,
      );
    }
  }

  return statements;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function label(row) {
  const who = row.name || row.scout_name || row.scouter_name || '(no name)';
  return `${who} | ${row.campout || '(no campout)'} | ${row.order_created_at || '?'} | ${row.order_id}/${row.line_item_uid}`;
}

function printSection(title, items, render, verbose) {
  console.log(`\n${title}: ${items.length}`);
  const shown = verbose ? items : items.slice(0, 25);
  for (const item of shown) console.log(`  ${render(item)}`);
  if (shown.length < items.length) console.log(`  … ${items.length - shown.length} more (see report file, or --verbose)`);
}

function printReport(plan, args) {
  printSection('Missing from D1 (will insert)', plan.missing,
    (row) => `${label(row)} [${row.payment_status || 'unknown'}]`, args.verbose);

  printSection('Differ from Square (will update)', plan.changed, ({ row, diffs }) => [
    label(row),
    ...diffs.map((d) => `      ${d.field}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}${d.demotion ? '  (demotion)' : ''}`),
  ].join('\n'), args.verbose);

  printSection('PAID in D1 but UNPAID per Square (held; --allow-demote to apply)', plan.heldDemotions,
    label, args.verbose);

  printSection(`In D1 but not in Square (${args.deleteOrphans ? 'will DELETE' : 'kept; --delete-orphans to remove'})`,
    plan.orphans, ({ row, reason }) => `${label(row)} [${reason}]`, args.verbose);

  if (plan.keptEmails.length) {
    console.log(`\nEmails Square could not reproduce, kept from D1: ${plan.keptEmails.length}`);
  }

  // Which columns drift most is often the quickest pointer to the cause.
  const byField = {};
  for (const { diffs } of plan.changed) for (const d of diffs) byField[d.field] = (byField[d.field] || 0) + 1;
  if (Object.keys(byField).length) {
    console.log('\nDifferences by column:');
    for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field.padEnd(24)} ${count}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .match(/\/\*\*([\s\S]*?)\*\//)[1]
  .replace(/^ \* ?/gm, '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  loadEnvFile(join(root, '..', '.env'));
  loadEnvFile(join(root, '.dev.vars'));

  const { env, source } = squareEnvFor(args.squareEnv);
  const config = squareConfig(env);
  const where = args.target.replace('--', '');

  console.error(`Square: ${config.environment} (${source}), location ${config.locationId}`);
  console.error(`D1:     ${DATABASE} (${where})`);
  if (args.since) console.error(`Since:  ${args.since}`);

  console.error('\nReading Square…');
  const square = await expectedRowsFromSquare(config, args.since);
  if (!square.orders.length) {
    throw new Error('Square returned no orders -- refusing to reconcile against nothing. '
      + 'Check the location id and --square-env.');
  }
  console.error(`  ${square.orders.length} order(s) -> ${square.rows.size} registration row(s)`
    + `${square.skipped ? `, ${square.skipped} skipped (no line item uid)` : ''}`);

  console.error('\nReading D1…');
  const d1 = readD1Rows(args.target);
  console.error(`  ${d1.size} row(s)`);

  const plan = compare(square.rows, d1, {
    orderIds: square.orderIds,
    since: args.since,
    allowDemote: args.allowDemote,
  });

  console.log(`\n=== Reconcile: Square ${config.environment} vs D1 ${where} ===`);
  console.log(`Square rows ${square.rows.size} | D1 rows ${d1.size} | already in sync ${plan.matched}`);
  printReport(plan, args);

  const now = new Date().toISOString();
  const statements = buildSql(plan, { now, deleteOrphans: args.deleteOrphans });

  const outDir = join(root, '.reconcile');
  mkdirSync(outDir, { recursive: true });
  const stamp = now.replace(/[:.]/g, '-');
  const reportPath = join(outDir, `report-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify({
    generated_at: now,
    square_environment: config.environment,
    d1_target: where,
    since: args.since,
    counts: {
      square_orders: square.orders.length,
      square_rows: square.rows.size,
      d1_rows: d1.size,
      matched: plan.matched,
      missing: plan.missing.length,
      changed: plan.changed.length,
      held_demotions: plan.heldDemotions.length,
      orphans: plan.orphans.length,
    },
    ...plan,
  }, null, 2));
  console.log(`\nReport: ${relative(process.cwd(), reportPath)}`);

  if (!statements.length) {
    console.log('\nNothing to write. D1 matches Square.');
    return;
  }

  const sqlPath = join(outDir, `apply-${stamp}.sql`);
  writeFileSync(sqlPath, `${statements.join('\n')}\n`);
  console.log(`SQL:    ${relative(process.cwd(), sqlPath)} (${statements.length} statement(s))`);

  if (!args.apply) {
    console.log('\nDry run -- nothing written. Re-run with --apply to write these changes.');
    return;
  }

  console.error(`\nApplying ${statements.length} statement(s) to D1 (${where})…`);
  wrangler(args.target, [`--file=${sqlPath}`]);
  const detail = `reconcile: ${plan.missing.length} inserted, ${plan.changed.length} updated`
    + `${args.deleteOrphans ? `, ${plan.orphans.length} deleted` : ''}`;
  wrangler(args.target, ['--command',
    `INSERT INTO sync_log (synced_at, rows_seen, ok, detail) VALUES (${sqlString(now)}, ${square.rows.size}, 1, ${sqlString(detail)})`]);
  console.log(`\nDone. ${detail}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // execFileSync errors carry wrangler's stderr, which says why.
    console.error(`\nReconcile failed: ${error.message}`);
    if (error.stderr) console.error(String(error.stderr).trim());
    process.exit(1);
  });
}
