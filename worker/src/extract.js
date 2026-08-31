/**
 * Turn Square orders into roster rows.
 *
 * Registration answers arrive as order line-item modifiers in two shapes:
 *
 *   1. The answer is in the modifier name:  "Scout Name: John Smith"
 *   2. The question is the modifier list's name and the answer is the
 *      modifier:  list "Rank:" containing modifier "Tenderfoot"
 *
 * This is a port of the Python extract_order_data(), and is held to it by
 * test/extract.test.js, which replays fixtures generated from that
 * implementation. Behavior changes here need the fixtures regenerated
 * deliberately (scripts/make_worker_fixture.py), never quietly adjusted.
 */

import { orderPaymentStatus } from './payments.js';

const FIELD_BY_QUESTION = {
  'Scout Name': 'scout_name',
  'Scouter Name': 'scouter_name',
  'Rank': 'rank',
  'Patrol': 'patrol',
  'Emergency Contact': 'emergency_contact',
  'Emergency Contact Phone Number': 'emergency_contact_phone',
  'Cell phone number': 'cell_phone',
  'Will you travel with the troop to the campout?': 'travel_to_campout',
};

// A bare question with no answer still tells us the person was asked.
const ANSWERABLE_WITHOUT_VALUE = new Set([
  'Scout Name', 'Scouter Name', 'Rank', 'Patrol',
]);

/**
 * Square exposes the buyer's email through a fulfillment recipient, and which
 * kind of fulfillment depends on how the order was placed. Orders carrying
 * only a customer_id need a separate Customers lookup (see sync.js).
 */
const FULFILLMENT_DETAILS = ['pickup_details', 'shipment_details', 'delivery_details'];

export function extractOrderEmail(order) {
  for (const fulfillment of order.fulfillments || []) {
    for (const field of FULFILLMENT_DETAILS) {
      const email = fulfillment?.[field]?.recipient?.email_address;
      if (email) return email;
    }
  }
  return '';
}

function emptyRow(order, lineItem, totalMoney, paymentStatus) {
  return {
    order_id: order.id,
    line_item_uid: lineItem.uid || '',
    order_created_at: order.created_at || '',
    payment_status: paymentStatus,
    email: extractOrderEmail(order),
    customer_id: order.customer_id || '',
    total_money: totalMoney,
    line_item_name: lineItem.name || '',
    variation_name: lineItem.variation_name || '',
    scout_name: '',
    scouter_name: '',
    rank: '',
    patrol: '',
    emergency_contact: '',
    emergency_contact_phone: '',
    cell_phone: '',
    travel_to_campout: '',
  };
}

function assign(row, question, value) {
  const field = FIELD_BY_QUESTION[question];
  if (field) row[field] = value;
}

function formatMoney(money) {
  // Refunded orders come back with no total_money at all.
  if (!money) return '0 USD';
  return `${money.amount} ${money.currency}`;
}

/**
 * Read a modifier that belongs to a modifier list, where the list name is the
 * question. A list named "Rank:" carries the answer after the colon; a list
 * named "Rank" leaves the modifier itself as the answer.
 */
function fromModifierList(row, listName, modifierName) {
  const colon = listName.indexOf(':');

  if (colon === -1) {
    assign(row, listName, modifierName);
    return;
  }

  const question = listName.slice(0, colon).trim();
  const value = listName.slice(colon + 1).trim();
  // The list name sometimes already contains the answer; only append the
  // modifier when it adds something.
  assign(row, question, value.includes(modifierName) ? value : `${value} - ${modifierName}`);
}

/** Read a standalone modifier, where the name carries "Question: Answer". */
function fromModifierName(row, modifierName) {
  const colon = modifierName.indexOf(':');

  if (colon === -1) {
    if (ANSWERABLE_WITHOUT_VALUE.has(modifierName)) assign(row, modifierName, 'Unknown');
    return;
  }

  assign(row, modifierName.slice(0, colon).trim(), modifierName.slice(colon + 1).trim());
}

/**
 * @param orders          Square orders
 * @param catalogById     every fetched catalog object, keyed by id (modifiers
 *                        and modifier lists alike)
 */
export function extractRows(orders, catalogById) {
  const rows = [];

  for (const order of orders) {
    const totalMoney = formatMoney(order.total_money);
    // Whether the buyer paid is a property of the order, so every line item on
    // it inherits the same answer.
    const paymentStatus = orderPaymentStatus(order);

    for (const lineItem of order.line_items || []) {
      const row = emptyRow(order, lineItem, totalMoney, paymentStatus);

      for (const modifier of lineItem.modifiers || []) {
        const catalogObject = catalogById[modifier.catalog_object_id];
        const modifierData = catalogObject?.modifier_data;

        // The catalog name is authoritative; the order copy can be stale.
        const modifierName = modifierData?.name || modifier.name || '';
        const listId = modifierData?.modifier_list_id;

        if (listId) {
          const listName = catalogById[listId]?.modifier_list_data?.name;
          if (listName) fromModifierList(row, listName, modifierName);
        } else {
          fromModifierName(row, modifierName);
        }
      }

      rows.push(row);
    }
  }

  return rows;
}

/** Catalog object ids referenced by these orders, grouped by catalog version. */
export function modifierIdsByVersion(orders) {
  const byVersion = new Map();

  for (const order of orders) {
    for (const lineItem of order.line_items || []) {
      for (const modifier of lineItem.modifiers || []) {
        if (!modifier.catalog_object_id) continue;
        const version = lineItem.catalog_version;
        if (!byVersion.has(version)) byVersion.set(version, new Set());
        byVersion.get(version).add(modifier.catalog_object_id);
      }
    }
  }

  return byVersion;
}

/**
 * Modifier lists referenced by already-fetched modifiers, grouped by version.
 * Square requires catalog reads to name a version, and a modifier only reveals
 * its list once fetched -- hence the second pass.
 */
export function modifierListIdsByVersion(orders, catalogById) {
  const byVersion = new Map();

  for (const order of orders) {
    for (const lineItem of order.line_items || []) {
      for (const modifier of lineItem.modifiers || []) {
        const listId = catalogById[modifier.catalog_object_id]?.modifier_data?.modifier_list_id;
        if (!listId || catalogById[listId]) continue;
        const version = lineItem.catalog_version;
        if (!byVersion.has(version)) byVersion.set(version, new Set());
        byVersion.get(version).add(listId);
      }
    }
  }

  return byVersion;
}
