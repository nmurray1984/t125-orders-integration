import test from 'node:test';
import assert from 'node:assert/strict';

import { groupSuggestions, suggestCampoutName } from '../src/mapping.js';
import { normalizeDate } from '../src/setup.js';

// The real Troop 125 catalog names, from the Square account.
const REAL_NAMES = [
  'Scout Registration - Advancement Campout - Sept 2026',
  'Scouter Registration - Advancement Campout - Sept 2026',
  'Scout Registration - NASA Campout - Oct 2026',
  'Scouter Registration - NASA Campout - Oct 2026',
  'Scout (and siblings) Registration - End of Year Pool Party 2026',
  'Scouter (Dads and Moms) Registration - End of Year Pool Party 2026',
  'Prospective Scout Registration - May 2026',
  'Prospective Scouter Registration - May 2026',
  'Scout Registration - May 2026',
  'Scouter Registration - May 2026',
];

test('the campout is read out of a registration name', () => {
  assert.equal(
    suggestCampoutName('Scout Registration - NASA Campout - Oct 2026'),
    'NASA Campout - Oct 2026',
  );
  assert.equal(
    suggestCampoutName('Scouter Registration - NASA Campout - Oct 2026'),
    'NASA Campout - Oct 2026',
  );
});

test('a qualifier in the prefix does not confuse it', () => {
  assert.equal(
    suggestCampoutName('Scout (and siblings) Registration - End of Year Pool Party 2026'),
    'End of Year Pool Party 2026',
  );
  assert.equal(
    suggestCampoutName('Prospective Scouter Registration - May 2026'),
    'May 2026',
  );
});

test('a name that does not fit the pattern is left alone', () => {
  assert.equal(suggestCampoutName('Summer Camp 2026'), 'Summer Camp 2026');
  assert.equal(suggestCampoutName(''), '');
  assert.equal(suggestCampoutName(undefined), '');
});

test('scout and scouter registrations collapse into one campout', () => {
  const groups = groupSuggestions(
    REAL_NAMES.map((line_item_name) => ({ line_item_name, registrations: 1 })),
  );

  assert.equal(groups.length, 4, 'ten registration types, four campouts');
  const names = groups.map((g) => g.suggested_name).sort();
  assert.deepEqual(names, [
    'Advancement Campout - Sept 2026',
    'End of Year Pool Party 2026',
    'May 2026',
    'NASA Campout - Oct 2026',
  ]);
});

test('already-grouped registrations are not suggested again', () => {
  const groups = groupSuggestions([
    { line_item_name: 'Scout Registration - NASA Campout - Oct 2026', campout_id: 1, registrations: 6 },
    { line_item_name: 'Scouter Registration - NASA Campout - Oct 2026', registrations: 6 },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].line_item_names,
    ['Scouter Registration - NASA Campout - Oct 2026']);
});

test('suggestions are ordered by how many registrations they cover', () => {
  const groups = groupSuggestions([
    { line_item_name: 'Scout Registration - Small Trip', registrations: 2 },
    { line_item_name: 'Scout Registration - Big Trip', registrations: 40 },
  ]);
  assert.equal(groups[0].suggested_name, 'Big Trip');
});

test('only real YYYY-MM-DD dates are accepted', () => {
  assert.equal(normalizeDate('2026-10-17'), '2026-10-17');
  assert.equal(normalizeDate(''), null, 'blank clears the date');
  assert.equal(normalizeDate(null), null);

  for (const bad of ['2026-13-01', '2026-02-30', '05/09/2026', 'not-a-date', '2026-1-1']) {
    assert.equal(normalizeDate(bad), undefined, `${bad} should be rejected`);
  }
});

test('a leap day is accepted in a leap year and refused otherwise', () => {
  assert.equal(normalizeDate('2028-02-29'), '2028-02-29');
  assert.equal(normalizeDate('2026-02-29'), undefined);
});
