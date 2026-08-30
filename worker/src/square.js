/**
 * Minimal Square REST client for the Worker.
 *
 * The official SDK targets Node, so this talks to the two endpoints we need
 * directly. Catalog reads must name a catalog version, and each order line
 * item carries its own -- mixing versions in one request fails -- so callers
 * group ids by version and we issue one request per group.
 */

const HOSTS = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
};

// Square pins behavior to a dated API version. Override with the
// SQUARE_API_VERSION var if you need to move it.
const DEFAULT_API_VERSION = '2025-01-23';

// Square caps batch-retrieve at 1000 ids; stay well under it.
const CATALOG_BATCH_SIZE = 500;

/**
 * Every Square endpoint this Worker is allowed to touch. All three are reads.
 *
 * Two of them are POSTs, which looks alarming but is not: Square takes search
 * and batch-retrieve criteria as a request body, so the verb says nothing
 * about whether anything changes. Nothing here creates, updates, deletes,
 * cancels, pays or refunds.
 *
 * This is enforced, not just documented -- request() rejects any path not on
 * the list, so adding a write would have to be a deliberate edit here rather
 * than a line slipped in somewhere else.
 */
const ALLOWED_ENDPOINTS = new Set([
  '/v2/orders/search',        // read: recent orders for a location
  '/v2/catalog/batch-retrieve', // read: modifier + modifier list objects
  '/v2/locations',            // read: locations this token can see
]);

// Customer lookups are per-id, so the path varies; matched by shape instead.
const CUSTOMER_PATH = /^\/v2\/customers\/[A-Za-z0-9_-]+$/;

export class SquareError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
  }
}

export function squareConfig(env) {
  const environment = env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  return {
    environment,
    host: HOSTS[environment],
    token: env.SQUARE_ACCESS_TOKEN,
    locationId: env.SQUARE_LOCATION_ID,
    apiVersion: env.SQUARE_API_VERSION || DEFAULT_API_VERSION,
    fetchLimit: Number.parseInt(env.SQUARE_FETCH_LIMIT ?? '70', 10) || 70,
  };
}

async function request(config, path, body) {
  if (!ALLOWED_ENDPOINTS.has(path) && !CUSTOMER_PATH.test(path)) {
    throw new Error(
      `Refusing to call ${path}: this Worker only reads from Square. `
      + `Add it to ALLOWED_ENDPOINTS in square.js if that is genuinely intended.`,
    );
  }

  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Square-Version': config.apiVersion,
  };

  const options = { method: 'GET', headers };
  if (body !== undefined) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${config.host}${path}`, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Summarize; never echo headers or the token.
    const detail = (payload.errors || [])
      .map((e) => e.detail || e.code)
      .filter(Boolean)
      .join('; ') || response.statusText;
    throw new SquareError(response.status, detail);
  }

  return payload;
}

export const READ_ONLY_ENDPOINTS = ALLOWED_ENDPOINTS;

/** Recent orders for the configured location, newest first. */
export async function searchOrders(config) {
  const orders = [];
  let cursor;

  do {
    const body = {
      location_ids: [config.locationId],
      limit: Math.min(config.fetchLimit - orders.length, 500),
    };
    if (cursor) body.cursor = cursor;

    const page = await request(config, '/v2/orders/search', body);
    orders.push(...(page.orders || []));
    cursor = page.cursor;
  } while (cursor && orders.length < config.fetchLimit);

  return orders.slice(0, config.fetchLimit);
}

/**
 * Fetch catalog objects, one request per catalog version.
 * @param idsByVersion Map<version, Set<id>>
 * @returns objects keyed by id
 */
export async function fetchCatalogObjects(config, idsByVersion) {
  const objects = {};

  for (const [version, ids] of idsByVersion) {
    const all = [...ids];

    for (let i = 0; i < all.length; i += CATALOG_BATCH_SIZE) {
      const body = { object_ids: all.slice(i, i + CATALOG_BATCH_SIZE) };
      // Orders from an unversioned line item come back without one.
      if (version !== undefined && version !== null) body.catalog_version = version;

      const page = await request(config, '/v2/catalog/batch-retrieve', body);
      for (const object of page.objects || []) objects[object.id] = object;
    }
  }

  return objects;
}

/** Locations this token can see -- used by the credential check. */
export async function listLocations(config) {
  const payload = await request(config, '/v2/locations');
  return payload.locations || [];
}

/**
 * Look up one customer's email. Used only for orders that carry a customer_id
 * but no fulfillment recipient. Returns '' rather than throwing: a missing
 * email should never fail a sync.
 */
export async function fetchCustomerEmail(config, customerId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(customerId || ''))) return '';
  try {
    const payload = await request(config, `/v2/customers/${customerId}`);
    return payload.customer?.email_address || '';
  } catch {
    return '';
  }
}

/** Exposed so tests can assert the Worker cannot reach a write endpoint. */
export async function callSquare(config, path, body) {
  return request(config, path, body);
}
