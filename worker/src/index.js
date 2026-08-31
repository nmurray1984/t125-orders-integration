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
import { CAMPOUT_JOIN, CAMPOUT_NAME, groupSuggestions } from './mapping.js';
import { ROSTER_COLUMNS, toCsv } from './csv.js';
import {
  VISIBLE_REGISTRATIONS,
  normalizeRow,
  recordSync,
  upsertRows,
} from './registrations.js';
import { runSync } from './sync.js';
import {
  applyGrouping,
  assignRegistrationType,
  createCampout,
  deleteCampout,
  readSetup,
  updateCampout,
} from './setup.js';

const ALL_CAMPOUTS = '__all__';

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
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
      await recordSync(env, {
        syncedAt,
        rowsSeen: rows.length,
        detail: skipped ? `${skipped} row(s) skipped` : '',
      });
    }
  } catch (error) {
    return json({ error: `database error: ${error.message}` }, { status: 500 });
  }

  return json({ ok: true, upserted: rows.length, skipped, synced_at: syncedAt });
}

/**
 * Run the Square sync on demand. Same work the cron does -- useful right after
 * deploying, rather than waiting for the next scheduled run.
 */
async function handleRunSync(request, env) {
  if (!(await hasValidSyncToken(env, request))) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runSync(env);
    return json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return json({ error: `sync failed: ${error.message}` }, { status: 502 });
  }
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
    `SELECT ${CAMPOUT_NAME} AS campout,
            MAX(c.starts_at) AS configured_starts_at,
            COUNT(*) AS registrations,
            COUNT(DISTINCT registrations.campout) AS registration_types,
            MIN(order_created_at) AS first_order_at,
            MAX(order_created_at) AS last_order_at
     FROM registrations
     ${CAMPOUT_JOIN}
     WHERE registrations.campout <> '' AND ${VISIBLE_REGISTRATIONS}
     GROUP BY ${CAMPOUT_NAME}`,
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
       WHERE ${VISIBLE_REGISTRATIONS}
       GROUP BY patrol ORDER BY headcount DESC, patrol ASC`,
    ).all();
    return results ?? [];
  }

  const { results } = await env.DB.prepare(
    `SELECT registrations.patrol AS patrol, COUNT(*) AS headcount
     FROM registrations
     ${CAMPOUT_JOIN}
     WHERE ${CAMPOUT_NAME} = ?1 AND ${VISIBLE_REGISTRATIONS}
     GROUP BY registrations.patrol
     ORDER BY headcount DESC, patrol ASC`,
  ).bind(campout).all();
  return results ?? [];
}

async function rosterRows(env, campout) {
  const query =
    campout && campout !== ALL_CAMPOUTS
      ? env.DB.prepare(
          `SELECT registrations.*, ${CAMPOUT_NAME} AS campout_name
           FROM registrations
           ${CAMPOUT_JOIN}
           WHERE ${CAMPOUT_NAME} = ?1 AND ${VISIBLE_REGISTRATIONS}
           ORDER BY registrations.patrol ASC, registrations.name ASC`,
        ).bind(campout)
      : env.DB.prepare(
          `SELECT registrations.*, ${CAMPOUT_NAME} AS campout_name
           FROM registrations
           ${CAMPOUT_JOIN}
           WHERE ${VISIBLE_REGISTRATIONS}
           ORDER BY registrations.order_created_at DESC,
                    registrations.patrol ASC, registrations.name ASC`,
        );
  const { results } = await query.all();
  return results ?? [];
}

/**
 * How many registrations are being withheld for want of a payment.
 *
 * Hiding them silently is what turns an abandoned checkout into "the roster is
 * broken" -- somebody swears they signed up and is not on the list. The count
 * says the sync saw them and Square never took the money.
 */
async function unpaidCount(env, campout) {
  const query =
    campout && campout !== ALL_CAMPOUTS
      ? env.DB.prepare(
          `SELECT COUNT(*) AS unpaid
           FROM registrations
           ${CAMPOUT_JOIN}
           WHERE ${CAMPOUT_NAME} = ?1 AND NOT (${VISIBLE_REGISTRATIONS})`,
        ).bind(campout)
      : env.DB.prepare(
          `SELECT COUNT(*) AS unpaid FROM registrations
           WHERE NOT (${VISIBLE_REGISTRATIONS})`,
        );

  const row = await query.first();
  return row?.unpaid ?? 0;
}

async function handleRoster(url, env) {
  const campout = url.searchParams.get('campout');
  const [rows, patrols, unpaid] = await Promise.all([
    rosterRows(env, campout),
    patrolCounts(env, campout),
    unpaidCount(env, campout),
  ]);

  return json({
    campout: campout ?? ALL_CAMPOUTS,
    rows,
    patrols,
    headcount: rows.length,
    unpaid,
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

/**
 * Campout setup. Everyone with the troop password can edit this -- the same
 * trust level as reading the roster, which is the model throughout.
 */
async function handleSetup(url, request, env) {
  const path = url.pathname.replace(/^\/api\/setup/, '') || '/';

  if (path === '/' && request.method === 'GET') {
    return json(await readSetup(env));
  }

  // Only the methods that carry a payload need one. DELETE has no body, and
  // demanding JSON from it rejected every delete with a 400.
  const expectsBody = request.method === 'POST' || request.method === 'PATCH';
  const body = expectsBody ? await request.json().catch(() => null) : {};
  if (body === null) return json({ error: 'invalid JSON body' }, { status: 400 });

  const respond = (result) =>
    (result.error
      ? json({ error: result.error }, { status: result.status || 400 })
      : json(result));

  if (path === '/campouts' && request.method === 'POST') {
    return respond(await createCampout(env, body));
  }

  if (path === '/assign' && request.method === 'POST') {
    return respond(await assignRegistrationType(env, body));
  }

  if (path === '/group' && request.method === 'POST') {
    return respond(await applyGrouping(env, body));
  }

  const campoutMatch = path.match(/^\/campouts\/(\d+)$/);
  if (campoutMatch) {
    const id = Number(campoutMatch[1]);
    if (request.method === 'PATCH') return respond(await updateCampout(env, id, body));
    if (request.method === 'DELETE') return respond(await deleteCampout(env, id));
  }

  return json({ error: 'not found' }, { status: 404 });
}

function missingConfig(env) {
  const missing = ['DB', 'SESSION_SECRET', 'TROOP_PASSWORD', 'SYNC_TOKEN'].filter((k) => !env[k]);
  return missing.length ? missing : null;
}

export default {
  /**
   * Cron entry point. Cloudflare gives a scheduled invocation its own
   * lifetime, so waitUntil keeps the sync alive to completion rather than
   * being cut off when the handler returns.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await runSync(env);
        console.log('scheduled sync', JSON.stringify(result));
      } catch (error) {
        // Recorded so the UI's "last synced" does not silently freeze.
        console.error('scheduled sync failed:', error.message);
        try {
          await recordSync(env, {
            syncedAt: new Date().toISOString(),
            rowsSeen: 0,
            ok: false,
            detail: error.message.slice(0, 300),
          });
        } catch (logError) {
          console.error('could not record the failure:', logError.message);
        }
      }
    })());
  },

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

    if (url.pathname === '/api/run-sync' && request.method === 'POST') {
      return handleRunSync(request, env);
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
      if (url.pathname.startsWith('/api/setup')) return handleSetup(url, request, env);
    } catch (error) {
      return json({ error: `database error: ${error.message}` }, { status: 500 });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
};
