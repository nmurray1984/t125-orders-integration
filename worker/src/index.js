import {
  clearFailedLogins,
  clearSessionCookie,
  clientIp,
  createSessionCookie,
  hasValidSession,
  hasValidSyncToken,
  isSecureRequest,
  loginThrottle,
  passwordMatches,
  recordFailedLogin,
} from './auth.js';
import { annotateCampouts } from './campouts.js';
import { ROSTER_COLUMNS, toCsv } from './csv.js';

const ALL_CAMPOUTS = '__all__';
const UPSERT_CHUNK_SIZE = 50;

const REGISTRATION_FIELDS = [
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
  'order_created_at',
];

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Rows arrive from the Python sync, which builds them from Square modifier
 * parsing. Normalize here so a malformed row can never widen the schema or
 * smuggle an unexpected column into the upsert.
 */
function normalizeRow(raw) {
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

async function upsertRows(env, rows, syncedAt) {
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

async function handleSync(request, env) {
  if (!(await hasValidSyncToken(env, request))) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const incoming = Array.isArray(payload?.rows) ? payload.rows : null;
  if (!incoming) return json({ error: 'body must be { "rows": [...] }' }, { status: 400 });

  const rows = incoming.map(normalizeRow).filter(Boolean);
  const skipped = incoming.length - rows.length;
  const syncedAt = new Date().toISOString();

  try {
    if (rows.length) await upsertRows(env, rows, syncedAt);
    // Only the final batch records the sync, so a multi-batch run logs once.
    if (payload.final !== false) {
      await env.DB.prepare(
        'INSERT INTO sync_log (synced_at, rows_seen, ok, detail) VALUES (?1, ?2, 1, ?3)',
      ).bind(syncedAt, rows.length, skipped ? `${skipped} row(s) skipped` : '').run();
    }
  } catch (error) {
    return json({ error: `database error: ${error.message}` }, { status: 500 });
  }

  return json({ ok: true, upserted: rows.length, skipped, synced_at: syncedAt });
}

async function handleLogin(request, env) {
  const ip = clientIp(request);
  const throttle = await loginThrottle(env, ip);
  if (!throttle.allowed) {
    return json(
      { error: 'Too many attempts. Try again later.', retry_after: throttle.retryAfter },
      { status: 429, headers: { 'Retry-After': String(throttle.retryAfter) } },
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!(await passwordMatches(env, payload?.password))) {
    await recordFailedLogin(env, ip);
    return json({ error: 'Incorrect password.' }, { status: 401 });
  }

  await clearFailedLogins(env, ip);
  const cookie = await createSessionCookie(env, isSecureRequest(request));
  return json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}

async function lastSyncedAt(env) {
  const row = await env.DB.prepare(
    'SELECT synced_at FROM sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1',
  ).first();
  return row?.synced_at ?? null;
}

async function handleCampouts(env) {
  const { results } = await env.DB.prepare(
    `SELECT campout,
            COUNT(*) AS registrations,
            MIN(order_created_at) AS first_order_at,
            MAX(order_created_at) AS last_order_at
     FROM registrations
     WHERE campout <> ''
     GROUP BY campout`,
  ).all();

  return json({
    campouts: annotateCampouts(results ?? []),
    last_synced_at: await lastSyncedAt(env),
  });
}

/** Headcount per patrol, for meal planning. */
async function patrolCounts(env, campout) {
  if (!campout || campout === ALL_CAMPOUTS) {
    const { results } = await env.DB.prepare(
      `SELECT patrol, COUNT(*) AS headcount FROM registrations
       GROUP BY patrol ORDER BY headcount DESC, patrol ASC`,
    ).all();
    return results ?? [];
  }

  const { results } = await env.DB.prepare(
    `SELECT patrol, COUNT(*) AS headcount FROM registrations WHERE campout = ?1
     GROUP BY patrol ORDER BY headcount DESC, patrol ASC`,
  ).bind(campout).all();
  return results ?? [];
}

async function rosterRows(env, campout) {
  const query =
    campout && campout !== ALL_CAMPOUTS
      ? env.DB.prepare(
          `SELECT * FROM registrations WHERE campout = ?1
           ORDER BY patrol ASC, name ASC`,
        ).bind(campout)
      : env.DB.prepare(
          `SELECT * FROM registrations
           ORDER BY order_created_at DESC, patrol ASC, name ASC`,
        );
  const { results } = await query.all();
  return results ?? [];
}

async function handleRoster(url, env) {
  const campout = url.searchParams.get('campout');
  const [rows, patrols] = await Promise.all([
    rosterRows(env, campout),
    patrolCounts(env, campout),
  ]);

  return json({
    campout: campout ?? ALL_CAMPOUTS,
    rows,
    patrols,
    headcount: rows.length,
    last_synced_at: await lastSyncedAt(env),
  });
}

async function handleExport(url, env) {
  const campout = url.searchParams.get('campout');
  const rows = await rosterRows(env, campout);
  const label = (campout && campout !== ALL_CAMPOUTS ? campout : 'all-campouts')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'roster';

  return new Response(toCsv(ROSTER_COLUMNS, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${label}-roster.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

function missingConfig(env) {
  const missing = ['DB', 'SESSION_SECRET', 'TROOP_PASSWORD', 'SYNC_TOKEN'].filter((k) => !env[k]);
  return missing.length ? missing : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const missing = missingConfig(env);
    if (missing) {
      return json(
        { error: `Worker is not configured. Missing: ${missing.join(', ')}` },
        { status: 503 },
      );
    }

    // Machine-to-machine, authenticated by bearer token rather than the cookie.
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const cleared = clearSessionCookie(isSecureRequest(request));
      return json({ ok: true }, { headers: { 'Set-Cookie': cleared } });
    }

    const authenticated = await hasValidSession(env, request);

    if (url.pathname === '/api/session') {
      return json({ authenticated });
    }

    if (!authenticated) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }

    try {
      if (url.pathname === '/api/campouts') return handleCampouts(env);
      if (url.pathname === '/api/roster') return handleRoster(url, env);
      if (url.pathname === '/api/export.csv') return handleExport(url, env);
    } catch (error) {
      return json({ error: `database error: ${error.message}` }, { status: 500 });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
};
