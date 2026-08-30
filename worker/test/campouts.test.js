import test from 'node:test';
import assert from 'node:assert/strict';

import { annotateCampouts, parseCampoutDate } from '../src/campouts.js';

const NOW = new Date('2026-08-30T12:00:00Z');
const iso = (name) => {
  const parsed = parseCampoutDate(name, NOW);
  return parsed ? parsed.toISOString().slice(0, 10) : null;
};

test('reads ISO dates out of the name', () => {
  assert.equal(iso('2026-11-14 Klondike'), '2026-11-14');
  assert.equal(iso('Campout 2026-01-03'), '2026-01-03');
});

test('reads month-and-day, with or without a year', () => {
  assert.equal(iso('Fall Camporee - Nov 14'), '2026-11-14');
  assert.equal(iso('Fall Camporee - November 14-16'), '2026-11-14');
  assert.equal(iso('Winter Klondike Jan 9, 2027'), '2027-01-09');
  assert.equal(iso('Sept. 5 Shakedown'), '2026-09-05');
});

test('reads numeric dates', () => {
  assert.equal(iso('Camporee 11/14'), '2026-11-14');
  assert.equal(iso('Camporee 11/14/2027'), '2027-11-14');
});

test('falls back to month precision', () => {
  assert.equal(iso('November 2026 Campout'), '2026-11-01');
});

test('a name with no date yields null', () => {
  assert.equal(iso('Fall Camporee'), null);
  assert.equal(iso('Caving Trip'), null);
  assert.equal(iso(''), null);
  assert.equal(iso(undefined), null);
});

test('impossible dates are rejected rather than rolled over', () => {
  assert.equal(iso('Feb 31 Campout'), null);
  assert.equal(iso('2026-02-30 Campout'), null);
});

test('a bare month/day picks the nearest year', () => {
  // Late August now: January is nearer as next year than as this year.
  assert.equal(iso('Klondike Jan 9'), '2027-01-09');
  // September is days away, so this year.
  assert.equal(iso('Shakedown Sep 12'), '2026-09-12');
});

test('the soonest future campout is the upcoming one', () => {
  const ordered = annotateCampouts([
    { campout: 'Winter Klondike Jan 9', last_order_at: '2026-08-29T00:00:00Z' },
    { campout: 'Fall Camporee Sep 12', last_order_at: '2026-08-01T00:00:00Z' },
    { campout: 'Spring Camporee Apr 3 2026', last_order_at: '2026-03-01T00:00:00Z' },
  ], NOW);

  assert.equal(ordered[0].campout, 'Fall Camporee Sep 12');
  assert.equal(ordered[0].upcoming, true);
  assert.equal(ordered.filter((c) => c.upcoming).length, 1);
  assert.equal(ordered[ordered.length - 1].campout, 'Spring Camporee Apr 3 2026');
});

test('with no dates in any name it falls back to newest signup activity', () => {
  const ordered = annotateCampouts([
    { campout: 'Caving Trip', last_order_at: '2026-07-01T00:00:00Z' },
    { campout: 'Fall Camporee', last_order_at: '2026-08-28T00:00:00Z' },
  ], NOW);

  assert.equal(ordered[0].campout, 'Fall Camporee');
  assert.equal(ordered[0].upcoming, true);
});

test('a dated future campout beats a busier undated one', () => {
  const ordered = annotateCampouts([
    { campout: 'Undated Trip', last_order_at: '2026-08-29T23:00:00Z' },
    { campout: 'Fall Camporee Sep 12', last_order_at: '2026-08-01T00:00:00Z' },
  ], NOW);

  assert.equal(ordered.find((c) => c.upcoming).campout, 'Fall Camporee Sep 12');
});

test('all campouts in the past still yields exactly one selection', () => {
  const ordered = annotateCampouts([
    { campout: 'Spring Camporee Apr 3 2026', last_order_at: '2026-03-01T00:00:00Z' },
    { campout: 'Summer Camp Jul 4 2026', last_order_at: '2026-06-01T00:00:00Z' },
  ], NOW);

  assert.equal(ordered.filter((c) => c.upcoming).length, 1);
  assert.equal(ordered[0].campout, 'Summer Camp Jul 4 2026');
});

test('an empty list does not blow up', () => {
  assert.deepEqual(annotateCampouts([], NOW), []);
});
