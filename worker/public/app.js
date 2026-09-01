/* Troop 125 roster front end. Session state lives in an HttpOnly cookie, so
   this file never sees or stores the password after sign-in. */

import { loadSetup } from './setup.js';

const ALL = '__all__';

const el = (id) => document.getElementById(id);
const loginSection = el('login');
const appSection = el('app');
const setupSection = el('setup');
const rosterBody = el('roster-body');

// Rank order for sorting; anything unknown (adults, blanks) sorts last.
const RANK_ORDER = [
  'Scout', 'Tenderfoot', 'Second Class', 'First Class', 'Star', 'Life', 'Eagle',
];

let campouts = [];
let allRows = [];
let currentCampout = ALL;

function show(section) {
  loginSection.hidden = section !== 'login';
  appSection.hidden = section !== 'app';
  setupSection.hidden = section !== 'setup';
}

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (response.status === 401 && path !== '/api/login') {
    show('login');
    throw new Error('unauthorized');
  }
  return response;
}

/* --- Routing: each campout is its own URL ---------------------------- */

function isSetupPath() {
  return window.location.pathname.replace(/\/+$/, '') === '/setup';
}

function campoutFromPath() {
  const match = window.location.pathname.match(/^\/c\/(.+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function pathForCampout(campout) {
  return campout === ALL ? '/c/all' : `/c/${encodeURIComponent(campout)}`;
}

/* --- Formatting ------------------------------------------------------ */

function formatSyncedAt(iso) {
  if (!iso) return 'Never synced yet.';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return `Last synced ${iso}`;
  return `Last synced ${when.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function formatCampoutDate(startsAt) {
  if (!startsAt) return '';
  const when = new Date(`${startsAt}T12:00:00Z`);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function emailLink(value) {
  const link = document.createElement('a');
  link.href = `mailto:${value}`;
  link.textContent = value;
  return link;
}

/** Short local date; the full timestamp stays available on hover. */
function formatOrderedAt(value) {
  if (!value) return { text: '', title: '' };
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return { text: String(value), title: String(value) };
  return {
    text: when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    title: when.toLocaleString(),
  };
}

function phoneLink(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.length < 7) return document.createTextNode(value || '');
  const link = document.createElement('a');
  link.href = `tel:${digits}`;
  link.textContent = value;
  return link;
}

function tag(text, variant) {
  const span = document.createElement('span');
  span.className = variant ? `tag tag-${variant}` : 'tag';
  span.textContent = text;
  return span;
}

/* --- Headcount tiles -------------------------------------------------- */

function renderTotals(patrols, headcount, unpaid = 0) {
  el('hero-total').textContent = String(headcount);

  // Registrations Square never took money for are left off the roster
  // entirely. Say so, or the first question is why someone is missing.
  const note = el('unpaid-note');
  note.hidden = !unpaid;
  note.textContent = unpaid === 1
    ? '1 checkout started but never paid for, not shown'
    : `${unpaid} checkouts started but never paid for, not shown`;

  const list = el('patrol-tiles');
  list.replaceChildren();

  for (const { patrol, headcount: count } of patrols) {
    const item = document.createElement('li');
    item.className = 'tile';

    const value = document.createElement('p');
    value.className = 'tile-value';
    value.textContent = String(count);

    const label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = patrol || 'No patrol';

    item.append(value, label);
    list.append(item);
  }
}

/* --- Roster ----------------------------------------------------------- */

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email', email: true },
  { key: 'rank', label: 'Rank' },
  { key: 'patrol', label: 'Patrol' },
  { key: 'cell_phone', label: 'Cell', phone: true },
  { key: 'emergency_contact', label: 'Emergency contact' },
  { key: 'emergency_contact_phone', label: 'Emergency phone', phone: true },
  { key: 'travel_to_campout', label: 'Travels w/ troop' },
  { key: 'order_created_at', label: 'Ordered', date: true },
];

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

const SORTS = {
  name: byName,
  patrol: (a, b) => (a.patrol || '').localeCompare(b.patrol || '') || byName(a, b),
  rank: (a, b) => {
    const rank = (row) => {
      const index = RANK_ORDER.indexOf(row.rank);
      return index === -1 ? RANK_ORDER.length : index;
    };
    return rank(a) - rank(b) || byName(a, b);
  },
  // RFC3339 sorts correctly as a string, so no parsing needed.
  recent: (a, b) =>
    String(b.order_created_at || '').localeCompare(String(a.order_created_at || '')) || byName(a, b),
  oldest: (a, b) =>
    String(a.order_created_at || '').localeCompare(String(b.order_created_at || '')) || byName(a, b),
};

// What the roster opens on; the <select> lists this option first to match.
const DEFAULT_SORT = 'patrol';

/**
 * The mobile card and the desktop row share one <tr>: CSS decides which
 * reading it gets. The name cell carries the tags so they stay with the
 * person's name in card view.
 */
function renderRows(rows) {
  rosterBody.replaceChildren();

  for (const row of rows) {
    const tr = document.createElement('tr');

    for (const column of COLUMNS) {
      const td = document.createElement('td');
      const value = row[column.key] || '';
      if (!value) td.dataset.empty = 'true';

      // A real element rather than a ::before, so the card layout's labels are
      // readable by screen readers once the header row is gone on mobile.
      if (column.key !== 'name') {
        const label = document.createElement('span');
        label.className = 'cell-label';
        label.textContent = column.label;
        td.append(label);
      }

      if (column.date) {
        const { text: shown, title } = formatOrderedAt(value);
        if (title) td.title = title;
        td.append(document.createTextNode(shown));
        tr.append(td);
        continue;
      }

      if (column.email && value) {
        td.append(emailLink(value));
        tr.append(td);
        continue;
      }

      if (column.key === 'name') {
        const name = document.createElement('span');
        name.className = 'person-name';
        name.textContent = value;

        const tags = document.createElement('span');
        tags.className = 'tags';
        if (row.rank) tags.append(tag(row.rank, 'rank'));
        if (row.patrol) tags.append(tag(row.patrol, 'patrol'));
        if (!row.rank && row.scouter_name) tags.append(tag('Adult', 'adult'));
        if (/^no$/i.test(row.travel_to_campout)) tags.append(tag('Own transport', 'warn'));

        td.append(name, tags);
      } else {
        td.append(column.phone && value ? phoneLink(value) : document.createTextNode(value));
      }

      tr.append(td);
    }

    rosterBody.append(tr);
  }

  el('empty').hidden = rows.length > 0;
}

/** What a search term is matched against: raw values, plus what a date column
    actually shows, so typing "Aug" finds August signups. */
function searchableText(row) {
  return COLUMNS.map((column) => {
    const value = row[column.key] || '';
    if (!value) return '';
    return column.date ? `${value} ${formatOrderedAt(value).text}` : String(value);
  }).join(' ').toLowerCase();
}

function applyView() {
  const term = el('search').value.trim().toLowerCase();
  const filtered = term
    ? allRows.filter((row) => searchableText(row).includes(term))
    : allRows;

  const sorted = [...filtered].sort(SORTS[el('sort').value] || SORTS[DEFAULT_SORT]);
  renderRows(sorted);

  const scope = term ? `${sorted.length} of ${allRows.length}` : String(allRows.length);
  el('summary').textContent = `Showing ${scope} registration${allRows.length === 1 ? '' : 's'}`;
}

/* --- Loading ---------------------------------------------------------- */

function renderPicker() {
  const select = el('campout');
  select.replaceChildren();

  const groups = [
    ['Upcoming', campouts.filter((c) => c.is_past === false)],
    ['Date not in name', campouts.filter((c) => c.is_past === null)],
    ['Past', campouts.filter((c) => c.is_past === true)],
  ];

  for (const [label, entries] of groups) {
    if (!entries.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.campout;
      option.textContent = `${entry.campout} — ${entry.registrations}`;
      group.append(option);
    }
    select.append(group);
  }

  const all = document.createElement('option');
  all.value = ALL;
  all.textContent = 'All campouts';
  select.append(all);

  select.value = currentCampout;
}

function renderHeader() {
  const entry = campouts.find((c) => c.campout === currentCampout);
  el('campout-title').textContent =
    currentCampout === ALL ? 'All campouts' : currentCampout;

  const parts = [];
  if (entry?.upcoming) parts.push('Next campout');
  const date = formatCampoutDate(entry?.starts_at);
  if (date) parts.push(date);
  el('eyebrow').textContent = parts.join(' · ');

  document.title = currentCampout === ALL
    ? 'Troop 125 Campout Roster'
    : `${currentCampout} — Troop 125`;
}

async function loadCampouts() {
  const response = await api('/api/campouts');
  const data = await response.json();
  campouts = data.campouts || [];
  el('sync-note').textContent = formatSyncedAt(data.last_synced_at);
}

async function loadRoster() {
  const response = await api(`/api/roster?campout=${encodeURIComponent(currentCampout)}`);
  const data = await response.json();

  allRows = data.rows || [];
  renderTotals(data.patrols || [], data.headcount ?? allRows.length, data.unpaid ?? 0);
  el('export').href = `/api/export.csv?campout=${encodeURIComponent(currentCampout)}`;
  renderHeader();
  applyView();
}

async function showCampout(campout, { push = true } = {}) {
  currentCampout = campout;
  renderPicker();
  if (push) {
    const path = pathForCampout(campout);
    if (path !== window.location.pathname) window.history.pushState({ campout }, '', path);
  }
  await loadRoster();
}

async function enterApp() {
  if (isSetupPath()) {
    show('setup');
    await loadSetup();
    return;
  }

  show('app');
  await loadCampouts();

  const requested = campoutFromPath();
  const known = campouts.some((c) => c.campout === requested);
  const fallback = campouts.find((c) => c.upcoming)?.campout ?? ALL;

  // A deep link wins; otherwise open on the campout people are heading to next.
  const target = requested === 'all' ? ALL : (known ? requested : fallback);
  await showCampout(target, { push: true });
}

/* --- Events ----------------------------------------------------------- */

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('login-button');
  const error = el('login-error');
  error.hidden = true;
  button.disabled = true;

  try {
    const response = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: el('password').value }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      error.textContent = body.error || 'Sign in failed.';
      error.hidden = false;
      return;
    }

    el('password').value = '';

    // Loading the roster is a separate failure mode from signing in. A 401 here
    // means the session cookie was set but not sent back -- say that, rather
    // than blaming the network and sending someone hunting the wrong problem.
    try {
      await enterApp();
    } catch (loadError) {
      show('login');
      error.textContent =
        loadError.message === 'unauthorized'
          ? 'Signed in, but your browser did not keep the session cookie. ' +
            'Check that cookies are enabled for this site.'
          : 'Signed in, but the roster could not be loaded.';
      error.hidden = false;
    }
  } catch {
    error.textContent = 'Could not reach the server. Try again.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

el('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  allRows = [];
  show('login');
});

el('campout').addEventListener('change', (event) => showCampout(event.target.value));
el('search').addEventListener('input', applyView);
el('sort').addEventListener('change', applyView);
el('print').addEventListener('click', () => window.print());

// The setup page is a full navigation, so it does not need history handling
// here -- but coming back from it does.
window.addEventListener('popstate', () => {
  if (loginSection.hidden === false) return;
  if (isSetupPath()) {
    show('setup');
    loadSetup().catch(() => show('login'));
    return;
  }
  if (setupSection.hidden === false) {
    enterApp().catch(() => show('login'));
    return;
  }
  const requested = campoutFromPath();
  const target = requested === 'all' || !requested ? ALL : requested;
  showCampout(target, { push: false });
});

(async function start() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    const { authenticated } = await response.json();
    if (authenticated) {
      await enterApp();
      return;
    }
  } catch {
    /* fall through to the login screen */
  }
  show('login');
})();
