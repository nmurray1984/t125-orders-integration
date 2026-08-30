/**
 * The scheduled Square -> D1 sync.
 *
 * This replaces the GitHub Actions job that used to run square_orders.py:
 * fetch recent orders, resolve the catalog objects their modifiers point at,
 * parse them into roster rows, and upsert. It runs on a cron trigger inside
 * the same Worker that serves the roster.
 */

import { extractRows, modifierIdsByVersion, modifierListIdsByVersion } from './extract.js';
import { buildRegistration, normalizeRow, recordSync, upsertRows } from './registrations.js';
import { fetchCatalogObjects, fetchCustomerEmail, searchOrders, squareConfig } from './square.js';

export function missingSquareConfig(env) {
  const missing = ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'].filter((key) => !env[key]);
  return missing.length ? missing : null;
}

/**
 * Some orders carry a customer_id but no fulfillment recipient, so the email
 * needs a Customers lookup. Deduplicated by customer, and best-effort: a
 * lookup that fails leaves the email blank rather than failing the sync.
 */
async function fillMissingEmails(config, rows) {
  const needed = new Set(
    rows.filter((row) => !row.email && row.customer_id).map((row) => row.customer_id),
  );
  if (!needed.size) return;

  const emails = new Map();
  for (const customerId of needed) {
    emails.set(customerId, await fetchCustomerEmail(config, customerId));
  }

  for (const row of rows) {
    if (!row.email && row.customer_id) row.email = emails.get(row.customer_id) || '';
  }
}

export async function runSync(env) {
  const syncedAt = new Date().toISOString();
  const missing = missingSquareConfig(env);
  if (missing) {
    return { ok: false, error: `Square is not configured. Missing: ${missing.join(', ')}` };
  }

  const config = squareConfig(env);

  const orders = await searchOrders(config);
  if (!orders.length) {
    await recordSync(env, { syncedAt, rowsSeen: 0, detail: 'no orders returned' });
    return { ok: true, orders: 0, upserted: 0, synced_at: syncedAt };
  }

  // Two passes: a modifier only names its modifier list once fetched, and
  // catalog reads have to name a version.
  const catalogById = await fetchCatalogObjects(config, modifierIdsByVersion(orders));
  Object.assign(
    catalogById,
    await fetchCatalogObjects(config, modifierListIdsByVersion(orders, catalogById)),
  );

  const parsed = extractRows(orders, catalogById);
  await fillMissingEmails(config, parsed);

  const rows = parsed.map(buildRegistration).map(normalizeRow).filter(Boolean);
  const skipped = parsed.length - rows.length;

  if (rows.length) await upsertRows(env, rows, syncedAt);

  await recordSync(env, {
    syncedAt,
    rowsSeen: rows.length,
    detail: [
      `${config.environment}`,
      `${orders.length} order(s)`,
      skipped ? `${skipped} row(s) skipped` : '',
    ].filter(Boolean).join(', '),
  });

  return {
    ok: true,
    environment: config.environment,
    orders: orders.length,
    upserted: rows.length,
    skipped,
    synced_at: syncedAt,
  };
}
