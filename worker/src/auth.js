/**
 * Shared-password auth for the troop roster.
 *
 * One password for everyone, so the only real defenses are (a) never comparing
 * it in a way that leaks timing, (b) handing out a signed, expiring cookie so
 * the password itself isn't replayed on every request, and (c) throttling
 * guesses per IP. All three are here.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = 't125_session';
const RATE_WINDOW_SECONDS = 15 * 60;
const RATE_MAX_ATTEMPTS = 10;

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Compare by HMAC rather than by string, so neither the comparison time nor
 * the password length tells an attacker anything.
 */
export async function passwordMatches(env, submitted) {
  if (typeof submitted !== 'string' || !env.TROOP_PASSWORD) return false;
  const [got, want] = await Promise.all([
    hmac(env.SESSION_SECRET, `pw:${submitted}`),
    hmac(env.SESSION_SECRET, `pw:${env.TROOP_PASSWORD}`),
  ]);
  return timingSafeEqual(got, want);
}

function sessionDays(env) {
  const parsed = Number.parseInt(env.SESSION_DAYS ?? '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export async function createSessionCookie(env) {
  const maxAge = sessionDays(env) * 24 * 60 * 60;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  const signature = toBase64Url(await hmac(env.SESSION_SECRET, `session:${expires}`));
  const token = `${expires}.${signature}`;
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export async function hasValidSession(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;

  const separator = token.indexOf('.');
  if (separator === -1) return false;

  const expires = Number.parseInt(token.slice(0, separator), 10);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) return false;

  const expected = toBase64Url(await hmac(env.SESSION_SECRET, `session:${expires}`));
  return timingSafeEqual(encoder.encode(token.slice(separator + 1)), encoder.encode(expected));
}

/** The sync endpoint is machine-to-machine, so it uses its own bearer token. */
export async function hasValidSyncToken(env, request) {
  const header = request.headers.get('Authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix) || !env.SYNC_TOKEN) return false;
  const [got, want] = await Promise.all([
    hmac(env.SESSION_SECRET, `sync:${header.slice(prefix.length)}`),
    hmac(env.SESSION_SECRET, `sync:${env.SYNC_TOKEN}`),
  ]);
  return timingSafeEqual(got, want);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function loginThrottle(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT attempts, window_start FROM login_attempts WHERE ip = ?1',
  ).bind(ip).first();

  if (!row || now - row.window_start >= RATE_WINDOW_SECONDS) {
    return { allowed: true, retryAfter: 0 };
  }
  if (row.attempts < RATE_MAX_ATTEMPTS) {
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: false, retryAfter: row.window_start + RATE_WINDOW_SECONDS - now };
}

export async function recordFailedLogin(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT attempts, window_start FROM login_attempts WHERE ip = ?1',
  ).bind(ip).first();

  const withinWindow = row && now - row.window_start < RATE_WINDOW_SECONDS;
  const attempts = withinWindow ? row.attempts + 1 : 1;
  const windowStart = withinWindow ? row.window_start : now;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, attempts, window_start) VALUES (?1, ?2, ?3)
     ON CONFLICT(ip) DO UPDATE SET attempts = ?2, window_start = ?3`,
  ).bind(ip, attempts, windowStart).run();
}

export async function clearFailedLogins(env, ip) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();
}
