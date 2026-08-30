/**
 * Working out when a campout actually happens.
 *
 * Square gives us no campout date -- only the catalog item name and when each
 * order was paid for. So we read a date out of the name when one is there
 * ("Fall Camporee - Nov 14-16", "2026-11-14 Klondike") and fall back to signup
 * activity when it isn't: the campout people are currently paying for is
 * almost always the next one.
 */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

const MONTH_NAMES = Object.keys(MONTHS).join('|');

// "2026-11-14"
const ISO = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/;
// "Nov 14", "November 14-16", "Nov. 14, 2026"
const MONTH_DAY = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:\\s*[-–]\\s*\\d{1,2})?(?:\\s*,?\\s*(20\\d{2}))?\\b`, 'i');
// "11/14", "11/14/2026"
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/;
// "November 2026" -- month precision only, treated as the 1st
const MONTH_YEAR = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(20\\d{2})\\b`, 'i');

function utcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  // Reject impossible dates like Feb 31, which Date would roll over.
  if (date.getUTCMonth() !== ((month % 12) + 12) % 12) return null;
  return date;
}

/**
 * With no year in the name, pick the one that puts the date nearest to now.
 * A "Nov 14" seen in January means this year; seen in December it means next.
 */
function inferYear(month, day, now) {
  const candidates = [-1, 0, 1].map((offset) =>
    utcDate(now.getUTCFullYear() + offset, month, day),
  ).filter(Boolean);

  let best = null;
  for (const candidate of candidates) {
    if (!best || Math.abs(candidate - now) < Math.abs(best - now)) best = candidate;
  }
  return best;
}

/** Returns a Date for the campout's start, or null when the name has no date. */
export function parseCampoutDate(name, now = new Date()) {
  const text = String(name || '');

  const iso = text.match(ISO);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const monthDay = text.match(MONTH_DAY);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    return monthDay[3]
      ? utcDate(Number(monthDay[3]), month, day)
      : inferYear(month, day, now);
  }

  const numeric = text.match(NUMERIC);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    if (month > 11 || day > 31) return null;
    return numeric[3] ? utcDate(Number(numeric[3]), month, day) : inferYear(month, day, now);
  }

  const monthYear = text.match(MONTH_YEAR);
  if (monthYear) return utcDate(Number(monthYear[2]), MONTHS[monthYear[1].toLowerCase()], 1);

  return null;
}

function startOfDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Annotate campouts with a start date and order them for the picker: soonest
 * upcoming first, then the rest of the future, then past ones newest-first.
 * Exactly one campout is flagged `upcoming`.
 */
export function annotateCampouts(campouts, now = new Date()) {
  const today = startOfDay(now);

  const annotated = campouts.map((campout) => {
    // A date set on the setup page is authoritative; parsing the name is only
    // a fallback for campouts nobody has configured yet.
    const configured = campout.configured_starts_at
      ? new Date(`${campout.configured_starts_at}T00:00:00Z`)
      : null;
    const usable = configured && !Number.isNaN(configured.getTime())
      ? configured
      : parseCampoutDate(campout.campout, now);

    return {
      ...campout,
      starts_at: usable ? usable.toISOString().slice(0, 10) : null,
      date_source: usable ? (configured ? 'configured' : 'name') : null,
      is_past: usable ? startOfDay(usable) < today : null,
    };
  });

  const sortKey = (c) => (c.starts_at ? Date.parse(c.starts_at) : Date.parse(c.last_order_at || 0) || 0);

  const future = annotated.filter((c) => c.is_past === false).sort((a, b) => sortKey(a) - sortKey(b));
  const past = annotated.filter((c) => c.is_past === true).sort((a, b) => sortKey(b) - sortKey(a));
  // No date in the name: order by signup activity, newest first.
  const undated = annotated.filter((c) => c.is_past === null).sort((a, b) => sortKey(b) - sortKey(a));

  // Prefer the soonest genuinely-upcoming campout. With no dates to go on, the
  // one people are signing up for right now is the best available guess.
  const chosen = future[0] || undated[0] || past[0] || null;
  const ordered = [...future, ...undated, ...past].map((campout) => ({
    ...campout,
    upcoming: campout.campout === chosen?.campout,
  }));

  return ordered;
}
