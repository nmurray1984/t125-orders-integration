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
import { PAID, UNPAID, isUnpaidStatus } from './payments.js';
import {
  fetchCatalogObjects,
  fetchCustomerEmail,
  fetchPayments,
  searchOrders,
  squareConfig,
} from './square.js';

export function missingSquareConfig(env) {
  const missing = ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'].filter((key) => !env[key]);
  return missing.length ? missing : null;
}

/**
 * Ask Square for the payments behind this batch of orders.
 *
 * One listing answers two questions -- who the buyer was and whether they
 * actually paid -- so it is fetched once, and only when something still needs
 * it. Best-effort throughout: a payments listing that fails must never fail a
 * sync, it just leaves the rows saying what the orders themselves said.
 */
async function fetchPaymentsForRows(config, rows) {
  // Ask only as far back as the oldest order we actually fetched.
  const oldest = rows
    .map((row) => row.order_created_at)
    .filter(Boolean)
    .sort()[0];

  try {
    return await fetchPayments(config, oldest);
  } catch (error) {
    console.error('could not read payments:', error.message);
    return new Map();
  }
}

/**
 * Confirm the orders that look unpaid really are, before they get hidden.
 *
 * The order's own tenders are the first signal, but a payment can land against
 * an order whose tenders have not caught up, and being wrong here costs a real
 * registration its place on the roster. So a payment record can only ever
 * promote a row to PAID -- the absence of one changes nothing, since the
 * listing is a bounded walk that may not reach every order.
 */
function confirmPayments(rows, paymentsByOrder) {
  for (const row of rows) {
    if (row.payment_status !== UNPAID) continue;
    if (paymentsByOrder.get(row.order_id)?.paid) row.payment_status = PAID;
  }
}

/**
 * Fill in emails the order itself does not carry.
 *
 * In practice this is nearly all of them: the buyer types their email on the
 * final checkout page, for the receipt, so it lands on the Payment rather than
 * the Order. A customer lookup is the last resort, for orders with a customer
 * but no payment email.
 *
 * All of it is best-effort -- a missing email must never fail a sync.
 */
async function fillMissingEmails(config, rows, paymentsByOrder) {
  for (const row of rows) {
    if (!row.email) row.email = paymentsByOrder.get(row.order_id)?.email || '';
  }

  const needed = new Set(
    rows.filter((row) => !row.email && row.customer_id).map((row) => row.customer_id),
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

  // Both of the next two steps read the same payments listing, so fetch it
  // once, and only if a row is actually missing an email or looks unpaid.
  const wantsPayments = parsed.some((row) => !row.email || row.payment_status === UNPAID);
  const paymentsByOrder = wantsPayments
    ? await fetchPaymentsForRows(config, parsed)
    : new Map();

  confirmPayments(parsed, paymentsByOrder);
  await fillMissingEmails(config, parsed, paymentsByOrder);

  const rows = parsed.map(buildRegistration).map(normalizeRow).filter(Boolean);
  const skipped = parsed.length - rows.length;
  // Written, but hidden from the roster: an abandoned checkout that is paid
  // for later flips back to PAID on a later sync.
  const hidden = rows.filter((row) => isUnpaidStatus(row.payment_status)).length;

  if (rows.length) await upsertRows(env, rows, syncedAt);

  await recordSync(env, {
    syncedAt,
    rowsSeen: rows.length,
    detail: [
      `${config.environment}`,
      `${orders.length} order(s)`,
      hidden ? `${hidden} unpaid row(s) hidden` : '',
      skipped ? `${skipped} row(s) skipped` : '',
    ].filter(Boolean).join(', '),
  });

  return {
    ok: true,
    environment: config.environment,
    orders: orders.length,
    upserted: rows.length,
    unpaid: hidden,
    skipped,
    synced_at: syncedAt,
  };
}
