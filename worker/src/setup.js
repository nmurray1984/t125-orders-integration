/**
 * Campout setup: mapping Square registration types onto campouts, and giving
 * each campout a real date.
 *
 * Registration types are only ever listed from what the sync has actually
 * seen. You cannot map a campout that has not appeared in Square yet -- which
 * is why doing one test registration before sending the link out makes the new
 * campout configurable ahead of real signups.
 */

import { groupSuggestions, suggestCampoutName } from './mapping.js';

const MAX_NAME_LENGTH = 200;

function clean(value, limit = MAX_NAME_LENGTH) {
  return value === null || value === undefined ? '' : String(value).trim().slice(0, limit);
}

/** Accept only YYYY-MM-DD, and only if it is a real calendar date. */
export function normalizeDate(value) {
  const text = clean(value, 10);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;

  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;

  return valid ? text : undefined;
}

export async function readSetup(env) {
  const [campouts, types] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.name, c.starts_at,
              COUNT(rt.line_item_name) AS registration_types
       FROM campouts c
       LEFT JOIN registration_types rt ON rt.campout_id = c.id
       GROUP BY c.id
       ORDER BY COALESCE(c.starts_at, '9999') ASC, c.name ASC`,
    ).all(),

    // Only registration types the sync has actually produced rows for.
    env.DB.prepare(
      `SELECT registrations.campout AS line_item_name,
              COUNT(*) AS registrations,
              MIN(registrations.order_created_at) AS first_order_at,
              MAX(registrations.order_created_at) AS last_order_at,
              rt.campout_id AS campout_id
       FROM registrations
       LEFT JOIN registration_types rt ON rt.line_item_name = registrations.campout
       WHERE registrations.campout <> ''
       GROUP BY registrations.campout, rt.campout_id
       ORDER BY MAX(registrations.order_created_at) DESC, registrations.campout ASC`,
    ).all(),
  ]);

  const registrationTypes = (types.results ?? []).map((entry) => ({
    ...entry,
    suggested_name: suggestCampoutName(entry.line_item_name),
  }));

  return {
    campouts: campouts.results ?? [],
    registration_types: registrationTypes,
    suggestions: groupSuggestions(registrationTypes),
  };
}

export async function createCampout(env, { name, starts_at: startsAt }) {
  const cleanName = clean(name);
  if (!cleanName) return { error: 'A campout needs a name.', status: 400 };

  const date = normalizeDate(startsAt);
  if (date === undefined) return { error: 'Date must be YYYY-MM-DD.', status: 400 };

  const now = new Date().toISOString();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO campouts (name, starts_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3) RETURNING id, name, starts_at`,
    ).bind(cleanName, date, now).first();
    return { campout: row };
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) {
      return { error: `A campout called "${cleanName}" already exists.`, status: 409 };
    }
    throw error;
  }
}

export async function updateCampout(env, id, { name, starts_at: startsAt }) {
  const existing = await env.DB.prepare('SELECT id FROM campouts WHERE id = ?1')
    .bind(id).first();
  if (!existing) return { error: 'No such campout.', status: 404 };

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const cleanName = clean(name);
    if (!cleanName) return { error: 'A campout needs a name.', status: 400 };
    updates.push(`name = ?${values.push(cleanName)}`);
  }

  if (startsAt !== undefined) {
    const date = normalizeDate(startsAt);
    if (date === undefined) return { error: 'Date must be YYYY-MM-DD.', status: 400 };
    updates.push(`starts_at = ?${values.push(date)}`);
  }

  if (!updates.length) return { error: 'Nothing to update.', status: 400 };

  updates.push(`updated_at = ?${values.push(new Date().toISOString())}`);

  try {
    const row = await env.DB.prepare(
      `UPDATE campouts SET ${updates.join(', ')} WHERE id = ?${values.push(id)}
       RETURNING id, name, starts_at`,
    ).bind(...values).first();
    return { campout: row };
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) {
      return { error: 'Another campout already has that name.', status: 409 };
    }
    throw error;
  }
}

/** Deleting a campout unmaps its registration types; no roster row is lost. */
export async function deleteCampout(env, id) {
  const existing = await env.DB.prepare('SELECT id FROM campouts WHERE id = ?1')
    .bind(id).first();
  if (!existing) return { error: 'No such campout.', status: 404 };

  await env.DB.batch([
    env.DB.prepare('UPDATE registration_types SET campout_id = NULL WHERE campout_id = ?1')
      .bind(id),
    env.DB.prepare('DELETE FROM campouts WHERE id = ?1').bind(id),
  ]);

  return { ok: true };
}

/** Assign a registration type to a campout, or pass null to unmap it. */
export async function assignRegistrationType(env, { line_item_name: lineItemName, campout_id: campoutId }) {
  const name = clean(lineItemName);
  if (!name) return { error: 'Which registration type?', status: 400 };

  const seen = await env.DB.prepare(
    'SELECT 1 AS ok FROM registrations WHERE campout = ?1 LIMIT 1',
  ).bind(name).first();
  if (!seen) {
    return { error: `"${name}" has not been synced from Square yet.`, status: 400 };
  }

  if (campoutId !== null && campoutId !== undefined) {
    const campout = await env.DB.prepare('SELECT id FROM campouts WHERE id = ?1')
      .bind(campoutId).first();
    if (!campout) return { error: 'No such campout.', status: 404 };
  }

  await env.DB.prepare(
    `INSERT INTO registration_types (line_item_name, campout_id, assigned_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(line_item_name) DO UPDATE SET campout_id = ?2, assigned_at = ?3`,
  ).bind(name, campoutId ?? null, new Date().toISOString()).run();

  return { ok: true };
}

/**
 * Create a campout and assign several registration types to it at once --
 * what the setup page's suggested groupings do.
 */
export async function applyGrouping(env, { name, starts_at: startsAt, line_item_names: lineItemNames }) {
  if (!Array.isArray(lineItemNames) || !lineItemNames.length) {
    return { error: 'No registration types given.', status: 400 };
  }

  const created = await createCampout(env, { name, starts_at: startsAt });
  if (created.error) return created;

  for (const lineItemName of lineItemNames) {
    const assigned = await assignRegistrationType(env, {
      line_item_name: lineItemName,
      campout_id: created.campout.id,
    });
    if (assigned.error) return assigned;
  }

  return { campout: created.campout, assigned: lineItemNames.length };
}
