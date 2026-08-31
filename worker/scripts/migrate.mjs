/**
 * Apply schema.sql, then add any columns an older database is missing.
 *
 * Every CREATE in schema.sql is IF NOT EXISTS, so it is safe to re-run. Columns
 * added after the first deploy are not: SQLite has no
 * "ALTER TABLE ... ADD COLUMN IF NOT EXISTS", and a bare ALTER fails with
 * "duplicate column name" the second time. So this checks what is actually
 * there and only adds what is missing, which keeps `npm run db:init` safe to
 * run as often as you like.
 *
 *   node scripts/migrate.mjs --local     (default)
 *   node scripts/migrate.mjs --remote
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 't125-roster';
const target = process.argv.includes('--remote') ? '--remote' : '--local';

/** Columns added after the first release, in the order they were introduced. */
const ADDED_COLUMNS = [
  { table: 'registrations', column: 'email', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'registrations', column: 'customer_id', definition: "TEXT NOT NULL DEFAULT ''" },
  // Existing rows default to '' -- unknown, and therefore still visible. Only
  // orders a later sync positively reports as unpaid disappear from the roster.
  { table: 'registrations', column: 'payment_status', definition: "TEXT NOT NULL DEFAULT ''" },
];

function wrangler(args, { json = false } = {}) {
  const output = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, target, ...args, ...(json ? ['--json'] : [])],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!json) return output;

  // wrangler prints progress before the JSON payload.
  const start = output.indexOf('[');
  return JSON.parse(output.slice(start));
}

function existingColumns(table) {
  const result = wrangler(
    ['--command', `SELECT name FROM pragma_table_info('${table}')`],
    { json: true },
  );
  return new Set((result[0]?.results ?? []).map((row) => row.name));
}

console.log(`Applying schema.sql (${target.replace('--', '')})…`);
wrangler(['--file=./schema.sql']);

let added = 0;
for (const { table, column, definition } of ADDED_COLUMNS) {
  if (existingColumns(table).has(column)) continue;
  console.log(`  adding ${table}.${column}`);
  wrangler(['--command', `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`]);
  added += 1;
}

console.log(added ? `Added ${added} column(s).` : 'Schema already up to date.');
