/**
 * Deciding whether an order was actually paid for.
 *
 * Square creates the Order when the buyer reaches checkout, not when they pay.
 * Abandon the payment page and the order still exists, still carries every
 * registration answer the buyer typed, and still comes back from
 * SearchOrders -- which only excludes DRAFT orders unless a state filter says
 * otherwise. Those orders are indistinguishable from real registrations once
 * the modifiers are parsed, so the roster used to show people who never paid.
 *
 * This is a port of payment_status() in square_orders.py and is held to it by
 * the parser fixtures; change one and you change both.
 *
 * The bias here is deliberate: only say UNPAID when the order positively says
 * so. An order carrying no payment information at all is UNKNOWN, and readers
 * treat unknown as visible -- hiding a real registration is a far worse
 * failure than showing an abandoned one.
 */

export const PAID = 'PAID';
export const UNPAID = 'UNPAID';
export const CANCELED = 'CANCELED';
export const UNKNOWN = '';

/** Statuses a payment can carry without any money having moved. */
const DEAD_TENDER_STATES = new Set(['VOIDED', 'FAILED']);

/** Payment.status values that mean the money is captured or authorized. */
export const LIVE_PAYMENT_STATES = new Set(['COMPLETED', 'APPROVED']);

/** A tender that has not been voided or failed. */
function hasLiveTender(order) {
  return (order.tenders || []).some((tender) => {
    const status = tender?.card_details?.status;
    return !status || !DEAD_TENDER_STATES.has(status);
  });
}

function amount(money) {
  const value = money?.amount;
  return typeof value === 'number' ? value : null;
}

/**
 * PAID, UNPAID, CANCELED, or '' when the order says nothing either way.
 *
 * Checked in order of how directly each signal reports money: a tender is a
 * payment attached to this order, the amount still due is Square's own
 * arithmetic over those tenders, and the state is a summary that lags both --
 * a paid order can sit in OPEN until it is fulfilled.
 */
export function orderPaymentStatus(order) {
  if (!order) return UNKNOWN;
  if (order.state === 'CANCELED') return CANCELED;

  if (hasLiveTender(order)) return PAID;

  const due = amount(order.net_amount_due_money);
  if (due !== null) return due === 0 ? PAID : UNPAID;

  if (order.state === 'COMPLETED') return PAID;
  if (order.state === 'OPEN' || order.state === 'DRAFT') return UNPAID;

  return UNKNOWN;
}

/** Whether a status should keep a registration off the roster. */
export function isUnpaidStatus(status) {
  return status === UNPAID || status === CANCELED;
}

/**
 * Statuses that hide a row, as SQL literals. Anything else -- PAID, or the
 * empty status on rows synced before this column existed -- reads normally.
 */
export const HIDDEN_PAYMENT_STATUSES = [UNPAID, CANCELED];
