import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionCookie,
  hasValidSession,
  hasValidSyncToken,
  isSecureRequest,
  passwordMatches,
} from '../src/auth.js';
import { ROSTER_COLUMNS, toCsv } from '../src/csv.js';

const env = {
  SESSION_SECRET: 'test-session-secret',
  TROOP_PASSWORD: 'troop125-campouts',
  SYNC_TOKEN: 'sync-token-abc',
  SESSION_DAYS: '30',
};

const requestWithCookie = (cookie) =>
  new Request('https://roster.test/api/roster', { headers: cookie ? { Cookie: cookie } : {} });

test('correct password matches', async () => {
  assert.equal(await passwordMatches(env, 'troop125-campouts'), true);
});

test('wrong password does not match', async () => {
  assert.equal(await passwordMatches(env, 'troop125-campout'), false);
  assert.equal(await passwordMatches(env, ''), false);
  assert.equal(await passwordMatches(env, 'x'.repeat(500)), false);
});

test('non-string password is rejected rather than throwing', async () => {
  assert.equal(await passwordMatches(env, undefined), false);
  assert.equal(await passwordMatches(env, { toString: () => 'troop125-campouts' }), false);
});

test('a fresh session cookie validates', async () => {
  const setCookie = await createSessionCookie(env);
  const token = setCookie.split(';')[0];

  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal(await hasValidSession(env, requestWithCookie(token)), true);
});

test('Secure is set for https and omitted for http', () => {
  assert.equal(isSecureRequest(new Request('https://roster.test/api/login')), true);
  assert.equal(isSecureRequest(new Request('http://127.0.0.1:8787/api/login')), false);
});

test('an insecure-origin cookie still validates', async () => {
  // Dropping Secure for localhost must not weaken the signature check.
  const setCookie = await createSessionCookie(env, false);
  assert.doesNotMatch(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.equal(await hasValidSession(env, requestWithCookie(setCookie.split(';')[0])), true);
});

test('logout cookie matches the scheme it was set for', () => {
  assert.match(clearSessionCookie(true), /Secure/);
  assert.doesNotMatch(clearSessionCookie(false), /Secure/);
});

test('a tampered session cookie is rejected', async () => {
  const token = (await createSessionCookie(env)).split(';')[0];
  const [name, value] = token.split('=');
  const [expires, signature] = value.split('.');

  // Push the expiry out without re-signing -- the classic forgery attempt.
  const forged = `${name}=${Number(expires) + 86400}.${signature}`;
  assert.equal(await hasValidSession(env, requestWithCookie(forged)), false);
});

test('a session signed with a different secret is rejected', async () => {
  const token = (await createSessionCookie({ ...env, SESSION_SECRET: 'other' })).split(';')[0];
  assert.equal(await hasValidSession(env, requestWithCookie(token)), false);
});

test('an expired session is rejected', async () => {
  const expires = Math.floor(Date.now() / 1000) - 60;
  assert.equal(
    await hasValidSession(env, requestWithCookie(`${SESSION_COOKIE}=${expires}.anything`)),
    false,
  );
});

test('missing or malformed cookies are rejected', async () => {
  assert.equal(await hasValidSession(env, requestWithCookie(null)), false);
  assert.equal(await hasValidSession(env, requestWithCookie(`${SESSION_COOKIE}=garbage`)), false);
  assert.equal(await hasValidSession(env, requestWithCookie('other=value')), false);
});

test('logout cookie expires immediately', () => {
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test('sync token is checked as a bearer header', async () => {
  const withAuth = (value) =>
    new Request('https://roster.test/api/sync', {
      method: 'POST',
      headers: value ? { Authorization: value } : {},
    });

  assert.equal(await hasValidSyncToken(env, withAuth('Bearer sync-token-abc')), true);
  assert.equal(await hasValidSyncToken(env, withAuth('Bearer wrong')), false);
  assert.equal(await hasValidSyncToken(env, withAuth('sync-token-abc')), false);
  assert.equal(await hasValidSyncToken(env, withAuth(null)), false);
});

test('the troop password is not accepted as a sync token', async () => {
  const request = new Request('https://roster.test/api/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TROOP_PASSWORD}` },
  });
  assert.equal(await hasValidSyncToken(env, request), false);
});

test('CSV escapes quotes, commas and newlines', () => {
  const csv = toCsv(
    [{ key: 'name', label: 'Name' }, { key: 'patrol', label: 'Patrol' }],
    [{ name: 'Smith, John "JJ"', patrol: 'Eagle\nPatrol' }],
  );
  assert.match(csv, /"Smith, John ""JJ"""/);
  assert.match(csv, /"Eagle\nPatrol"/);
});

test('CSV neutralizes spreadsheet formula injection', () => {
  const csv = toCsv(
    [{ key: 'name', label: 'Name' }],
    [{ name: '=HYPERLINK("http://evil.test","click")' }, { name: '+1-555-0100' }],
  );
  assert.ok(csv.includes("'=HYPERLINK"), 'leading = should be quoted out');
  assert.ok(csv.includes("'+1-555-0100"), 'leading + should be quoted out');
});

test('CSV renders every roster column and tolerates missing values', () => {
  const csv = toCsv(ROSTER_COLUMNS, [{ name: 'Solo Scout' }]);
  const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(header.split(',').length, ROSTER_COLUMNS.length);
  assert.equal(row.split(',').length, ROSTER_COLUMNS.length);
  assert.ok(row.startsWith('Solo Scout,'));
});
