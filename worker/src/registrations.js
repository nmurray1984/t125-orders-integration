/**
 * Writing roster rows into D1.
 *
 * Shared by the scheduled Square sync and the POST /api/sync endpoint, so both
 * routes upsert identically. Syncs never delete: Square only returns a rolling
 * window of recent orders, and dropping anything outside that window is what
 * lost past campouts in the spreadsheet era.
 */

import { HIDDEN_PAYMENT_STATUSES } from './payments.js';

const UPSERT_CHUNK_SIZE = 50;

export const REGISTRATION_FIELDS = [
  'order_id',
  'line_item_uid',
  'campout',
  'variation_name',
  'name',
  'scout_name',
  'scouter_name',
  'rank',
  'patrol',
  'emergency_contact',
  'emergency_contact_phone',
  'cell_phone',
  'travel_to_campout',
  'total_money',
  'payment_status',
  'order_created_at',
  'email',
  'customer_id',
];

const DEFAULT_PATROL = 'Rocking Chair';

/**
 * The rows a reader is allowed to see.
 *
 * Unpaid and canceled orders are still stored -- an abandoned checkout that is
 * paid for later has to be able to flip back, and syncs never delete -- so the
 * roster, the campout list, the patrol counts and the CSV export all filter
 * with this instead. An unknown status ('' on anything synced before the
 * column existed) reads as visible: only an order Square positively reports as
 * unpaid disappears.
 */
export const VISIBLE_REGISTRATIONS =
  `registrations.payment_status NOT IN (${HIDDEN_PAYMENT_STATUSES.map((s) => `'${s}'`).join(', ')})`;

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Map a parsed order row to a registration row.
 *
 * Mirrors d1_sync.build_row() on the Python side: one Name column preferring
 * the scout, and adults with no patrol land in Rocking Chair.
 */
export function buildRegistration(parsed) {
  return {
    order_id: parsed.order_id,
    line_item_uid: parsed.line_item_uid,
    campout: parsed.line_item_name || '',
    variation_name: parsed.variation_name || '',
    name: parsed.scout_name || parsed.scouter_name || '',
    scout_name: parsed.scout_name || '',
    scouter_name: parsed.scouter_name || '',
    rank: parsed.rank || '',
    patrol: parsed.patrol || DEFAULT_PATROL,
    emergency_contact: parsed.emergency_contact || '',
    emergency_contact_phone: parsed.emergency_contact_phone || '',
    cell_phone: parsed.cell_phone || '',
    travel_to_campout: parsed.travel_to_campout || '',
    total_money: parsed.total_money || '',
    payment_status: parsed.payment_status || '',
    order_created_at: parsed.order_created_at || '',
    email: parsed.email || '',
    customer_id: parsed.customer_id || '',
  };
}

/**
 * Normalize an inbound row so a malformed one cannot widen the schema or
 * smuggle an unexpected column into the upsert. Returns null when the row has
 * no usable primary key.
 */
export function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const orderId = text(raw.order_id).trim();
  const lineItemUid = text(raw.line_item_uid).trim();
  if (!orderId || !lineItemUid) return null;

  const row = {};
  for (const field of REGISTRATION_FIELDS) row[field] = text(raw[field]).slice(0, 500);
  row.order_id = orderId;
  row.line_item_uid = lineItemUid;
  return row;
}

export async function upsertRows(env, rows, syncedAt) {
  const statement = env.DB.prepare(
    `INSERT INTO registrations (
       ${REGISTRATION_FIELDS.join(', ')}, first_seen_at, synced_at
     ) VALUES (${REGISTRATION_FIELDS.map((_, i) => `?${i + 1}`).join(', ')},
       ?${REGISTRATION_FIELDS.length + 1}, ?${REGISTRATION_FIELDS.length + 1})
     ON CONFLICT(order_id, line_item_uid) DO UPDATE SET
       ${REGISTRATION_FIELDS
         .filter((f) => f !== 'order_id' && f !== 'line_item_uid')
         .map((f) => `${f} = excluded.${f}`)
         .join(',\n       ')},
       synced_at = excluded.synced_at`,
  );

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    await env.DB.batch(
      chunk.map((row) => statement.bind(...REGISTRATION_FIELDS.map((f) => row[f]), syncedAt)),
    );
  }
}

export async function recordSync(env, { syncedAt, rowsSeen, ok = true, detail = '' }) {
  await env.DB.prepare(
    'INSERT INTO sync_log (synced_at, rows_seen, ok, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(syncedAt, rowsSeen, ok ? 1 : 0, detail).run();
}
