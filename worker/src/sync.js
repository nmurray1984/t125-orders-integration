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
import {
  fetchCatalogObjects,
  fetchCustomerEmail,
  fetchPaymentEmails,
  searchOrders,
  squareConfig,
} from './square.js';

export function missingSquareConfig(env) {
  const missing = ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'].filter((key) => !env[key]);
  return missing.length ? missing : null;
}

/**
 * Fill in emails the order itself does not carry.
 *
 * In practice this is nearly all of them: the buyer types their email on the
 * final checkout page, for the receipt, so it lands on the Payment rather than
 * the Order. One payments listing covers the whole batch. A customer lookup is
 * the last resort, for orders with a customer but no payment email.
 *
 * All of it is best-effort -- a missing email must never fail a sync.
 */
async function fillMissingEmails(config, rows) {
  const missing = () => rows.filter((row) => !row.email);
  if (!missing().length) return;

  // Ask only as far back as the oldest order we actually fetched.
  const oldest = rows
    .map((row) => row.order_created_at)
    .filter(Boolean)
    .sort()[0];

  try {
    const byOrder = await fetchPaymentEmails(config, oldest);
    for (const row of rows) {
      if (!row.email) row.email = byOrder.get(row.order_id) || '';
    }
  } catch (error) {
    console.error('could not read payment emails:', error.message);
  }

  const needed = new Set(
    missing().filter((row) => row.customer_id).map((row) => row.customer_id),
  );
  if (!needed.size) return;

  const byCustomer = new Map();
  for (const customerId of needed) {
    byCustomer.set(customerId, await fetchCustomerEmail(config, customerId));
  }

  for (const row of rows) {
    if (!row.email && row.customer_id) row.email = byCustomer.get(row.customer_id) || '';
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
