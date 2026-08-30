/* Troop 125 roster front end. Session state lives in an HttpOnly cookie, so
   this file never sees or stores the password after sign-in. */

const ALL = '__all__';

const el = (id) => document.getElementById(id);
const loginSection = el('login');
const appSection = el('app');
const rosterBody = el('roster-body');

let allRows = [];

function show(section) {
  loginSection.hidden = section !== 'login';
  appSection.hidden = section !== 'app';
}

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (response.status === 401 && path !== '/api/login') {
    show('login');
    throw new Error('unauthorized');
  }
  return response;
}

function formatSyncedAt(iso) {
  if (!iso) return 'Never synced yet.';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return `Last synced ${iso}`;
  return `Last synced ${when.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function phoneLink(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.length < 7) return document.createTextNode(value || '');
  const link = document.createElement('a');
  link.href = `tel:${digits}`;
  link.textContent = value;
  return link;
}

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'rank', label: 'Rank' },
  { key: 'patrol', label: 'Patrol' },
  { key: 'cell_phone', label: 'Cell', phone: true },
  { key: 'emergency_contact', label: 'Emergency contact' },
  { key: 'emergency_contact_phone', label: 'Emergency phone', phone: true },
  { key: 'travel_to_campout', label: 'Travels w/ troop' },
];

function renderRows(rows) {
  rosterBody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const column of COLUMNS) {
      const td = document.createElement('td');
      td.dataset.label = column.label;
      const value = row[column.key] || '';
      // Marked so the mobile card layout can drop label-only rows; the desktop
      // table keeps the empty cell to hold its column.
      if (!value) td.dataset.empty = 'true';
      // textContent / createTextNode throughout: never innerHTML with order data.
      td.append(column.phone && value ? phoneLink(value) : document.createTextNode(value));
      tr.append(td);
    }
    rosterBody.append(tr);
  }
  el('empty').hidden = rows.length > 0;
}

function applyFilter() {
  const term = el('search').value.trim().toLowerCase();
  const rows = term
    ? allRows.filter((row) =>
        COLUMNS.some((c) => String(row[c.key] || '').toLowerCase().includes(term)),
      )
    : allRows;

  renderRows(rows);
  const scope = term ? `${rows.length} of ${allRows.length}` : String(allRows.length);
  el('summary').textContent = `${scope} registration${allRows.length === 1 ? '' : 's'}`;
}

async function loadCampouts() {
  const response = await api('/api/campouts');
  const { campouts, last_synced_at: lastSyncedAt } = await response.json();

  const select = el('campout');
  const previous = select.value;
  select.replaceChildren();

  const allOption = document.createElement('option');
  allOption.value = ALL;
  allOption.textContent = 'All campouts';
  select.append(allOption);

  for (const entry of campouts) {
    const option = document.createElement('option');
    option.value = entry.campout;
    option.textContent = `${entry.campout} (${entry.registrations})`;
    select.append(option);
  }

  // Default to the most recent campout, which is what anyone opening this wants.
  select.value = previous || (campouts.length ? campouts[0].campout : ALL);
  el('sync-note').textContent = formatSyncedAt(lastSyncedAt);
}

async function loadRoster() {
  const campout = el('campout').value || ALL;
  const response = await api(`/api/roster?campout=${encodeURIComponent(campout)}`);
  const data = await response.json();
  allRows = data.rows || [];
  el('export').href = `/api/export.csv?campout=${encodeURIComponent(campout)}`;
  applyFilter();
}

async function enterApp() {
  show('app');
  await loadCampouts();
  await loadRoster();
}

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

    if (response.ok) {
      el('password').value = '';
      await enterApp();
      return;
    }

    const body = await response.json().catch(() => ({}));
    error.textContent = body.error || 'Sign in failed.';
    error.hidden = false;
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

el('campout').addEventListener('change', loadRoster);
el('search').addEventListener('input', applyFilter);
el('print').addEventListener('click', () => window.print());

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
