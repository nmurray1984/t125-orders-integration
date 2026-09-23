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
export const REFUNDED = 'REFUNDED';
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
 * Refund statuses that mean the money is not going back after all. Anything
 * else -- PENDING included -- counts: a refund that is still processing is a
 * decision already made, and the person is not coming.
 */
const DEAD_REFUND_STATES = new Set(['REJECTED', 'FAILED']);

function liveRefunds(order) {
  return (order.refunds || []).filter((refund) => !DEAD_REFUND_STATES.has(refund?.status));
}

/** Whether any refund against this order is completed or in progress. */
export function hasLiveRefund(order) {
  return liveRefunds(order).length > 0;
}

/**
 * Whether the live refunds cover the whole order.
 *
 * A partial refund says money went back, not whose -- on an order that signed
 * up two scouts it could be either of them, or a fee. Only a refund of the
 * full total marks every line item; a partial one is pinned to a person by
 * refundedLineItems() or not at all. An order with no total to compare
 * against has only the refund to go on.
 */
function fullyRefunded(order) {
  const refunds = liveRefunds(order);
  if (!refunds.length) return false;

  const total = amount(order.total_money);
  if (!total) return true;

  const refunded = refunds.reduce((sum, refund) => sum + (amount(refund.amount_money) || 0), 0);
  return refunded >= total;
}

/**
 * Line items that were refunded individually, as order id -> Set of line
 * item uids.
 *
 * An itemized refund in Square creates a separate return order whose
 * `returns` point back at the original order and line items. Return orders
 * are newer than the orders they return, so the same SearchOrders page that
 * holds the original holds the return. Only honored where the original order
 * carries a live refund, so a return whose refund failed changes nothing.
 */
export function refundedLineItems(orders) {
  const byOrder = new Map();

  for (const order of orders || []) {
    for (const ret of order?.returns || []) {
      if (!ret?.source_order_id) continue;
      for (const item of ret.return_line_items || []) {
        if (!item?.source_line_item_uid) continue;
        if (!byOrder.has(ret.source_order_id)) byOrder.set(ret.source_order_id, new Set());
        byOrder.get(ret.source_order_id).add(item.source_line_item_uid);
      }
    }
  }

  return byOrder;
}

/**
 * PAID, UNPAID, CANCELED, REFUNDED, or '' when the order says nothing either
 * way.
 *
 * A refund of the whole order outranks the payment it undoes. Otherwise
 * checked in order of how directly each signal reports money: a tender is a
 * payment attached to this order, the amount still due is Square's own
 * arithmetic over those tenders, and the state is a summary that lags both --
 * a paid order can sit in OPEN until it is fulfilled.
 */
export function orderPaymentStatus(order) {
  if (!order) return UNKNOWN;
  if (order.state === 'CANCELED') return CANCELED;
  if (fullyRefunded(order)) return REFUNDED;

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
 * The status one line item ends up with: the order's, unless that line was
 * refunded on its own. `refunded` is the map from refundedLineItems().
 */
export function lineItemPaymentStatus(order, lineItem, orderStatus, refunded) {
  if (orderStatus === CANCELED || orderStatus === REFUNDED) return orderStatus;
  if (!hasLiveRefund(order)) return orderStatus;
  return refunded?.get(order.id)?.has(lineItem?.uid) ? REFUNDED : orderStatus;
}

/**
 * Statuses that hide a row, as SQL literals. Anything else -- PAID, or the
 * empty status on rows synced before this column existed -- reads normally.
 */
export const HIDDEN_PAYMENT_STATUSES = [UNPAID, CANCELED];
