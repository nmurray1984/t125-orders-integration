/**
 * Grouping Square registration types into campouts.
 *
 * Square has no concept of a campout. One campout is sold as several catalog
 * items -- "Scout Registration - NASA Campout - Oct 2026" and "Scouter
 * Registration - NASA Campout - Oct 2026" are one weekend, two line items --
 * so the grouping is recorded in the `campouts` and `registration_types`
 * tables and applied when reading.
 *
 * `registrations.campout` holds the Square line item name, i.e. the
 * registration type. The campout a reader sees is resolved from it.
 */

/**
 * SQL that turns a registration row into its effective campout name: the
 * configured campout when one is mapped, otherwise the raw line item name so
 * nothing disappears before setup has been done.
 */
export const CAMPOUT_JOIN = `
  LEFT JOIN registration_types rt ON rt.line_item_name = registrations.campout
  LEFT JOIN campouts c ON c.id = rt.campout_id`;

export const CAMPOUT_NAME = 'COALESCE(c.name, registrations.campout)';

/**
 * Propose a campout name from a registration type.
 *
 * Troop 125 names catalog items "<who> Registration - <campout>", so dropping
 * everything through the first " - " after the word "Registration" leaves the
 * campout. Falls back to the whole name when the pattern does not fit -- a
 * suggestion is a starting point, never applied on its own.
 */
export function suggestCampoutName(lineItemName) {
  const name = String(lineItemName || '').trim();
  const stripped = name.replace(/^.*?\bRegistrations?\b[^-]*-\s*/i, '').trim();
  return stripped || name;
}

/**
 * Group unmapped registration types by the campout name they suggest, so the
 * setup page can offer "create this campout and assign both" in one action.
 */
export function groupSuggestions(registrationTypes) {
  const groups = new Map();

  for (const entry of registrationTypes) {
    if (entry.campout_id) continue;
    const suggested = suggestCampoutName(entry.line_item_name);
    if (!groups.has(suggested)) groups.set(suggested, []);
    groups.get(suggested).push(entry);
  }

  return [...groups.entries()]
    .map(([name, types]) => ({
      suggested_name: name,
      line_item_names: types.map((t) => t.line_item_name),
      registrations: types.reduce((sum, t) => sum + (t.registrations || 0), 0),
    }))
    .sort((a, b) => b.registrations - a.registrations);
}
