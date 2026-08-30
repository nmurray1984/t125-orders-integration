/* Campout setup: group Square registration types into campouts and date them.
   Loaded by app.js when the URL is /setup. */

const el = (id) => document.getElementById(id);

let state = { campouts: [], registration_types: [], suggestions: [] };

function showError(message) {
  const box = el('setup-error');
  box.textContent = message;
  box.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  if (response.status === 401) {
    window.location.reload();   // session gone; the shell will show the login
    throw new Error('unauthorized');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function countLabel(n) {
  return `${n} registration${n === 1 ? '' : 's'}`;
}

/* --- Suggested groupings --------------------------------------------- */

function renderSuggestions() {
  const container = el('suggestions');
  container.replaceChildren();

  el('unmapped-empty').hidden = state.suggestions.length > 0;

  for (const suggestion of state.suggestions) {
    const card = document.createElement('div');
    card.className = 'setup-card';

    const heading = document.createElement('div');
    heading.className = 'setup-card-head';

    const title = document.createElement('p');
    title.className = 'setup-card-title';
    title.textContent = suggestion.suggested_name;

    const count = document.createElement('p');
    count.className = 'muted';
    count.textContent =
      `${suggestion.line_item_names.length} registration types · ${countLabel(suggestion.registrations)}`;

    heading.append(title, count);

    const list = document.createElement('ul');
    list.className = 'type-list';
    for (const name of suggestion.line_item_names) {
      const item = document.createElement('li');
      item.textContent = name;
      list.append(item);
    }

    const actions = document.createElement('div');
    actions.className = 'setup-actions';

    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'inline-date';
    date.setAttribute('aria-label', `Date for ${suggestion.suggested_name}`);

    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'Create campout & group these';
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        await api('/api/setup/group', {
          method: 'POST',
          body: JSON.stringify({
            name: suggestion.suggested_name,
            starts_at: date.value || null,
            line_item_names: suggestion.line_item_names,
          }),
        });
        await load();
      } catch (error) {
        showError(error.message);
        create.disabled = false;
      }
    });

    // Assigning individually, for anything the suggestion lumped together
    // that should not be (prospective vs regular registrations, say).
    const separately = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Assign these individually instead';
    separately.append(summary);
    for (const name of suggestion.line_item_names) {
      separately.append(assignRow(name));
    }

    actions.append(date, create);
    card.append(heading, list, actions, separately);
    container.append(card);
  }
}

/** One "put this registration type in that campout" control. */
function assignRow(lineItemName) {
  const row = document.createElement('div');
  row.className = 'assign-row';

  const label = document.createElement('span');
  label.className = 'assign-name';
  label.textContent = lineItemName;

  const select = document.createElement('select');
  select.setAttribute('aria-label', `Campout for ${lineItemName}`);

  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Not grouped';
  select.append(none);

  for (const campout of state.campouts) {
    const option = document.createElement('option');
    option.value = String(campout.id);
    option.textContent = campout.name;
    select.append(option);
  }

  const current = state.registration_types.find((t) => t.line_item_name === lineItemName);
  select.value = current?.campout_id ? String(current.campout_id) : '';

  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api('/api/setup/assign', {
        method: 'POST',
        body: JSON.stringify({
          line_item_name: lineItemName,
          campout_id: select.value ? Number(select.value) : null,
        }),
      });
      await load();
    } catch (error) {
      showError(error.message);
      select.disabled = false;
    }
  });

  row.append(label, select);
  return row;
}

/* --- Campouts --------------------------------------------------------- */

function renderCampouts() {
  const container = el('campout-list');
  container.replaceChildren();

  el('campouts-empty').hidden = state.campouts.length > 0;

  for (const campout of state.campouts) {
    const card = document.createElement('div');
    card.className = 'setup-card';

    const form = document.createElement('form');
    form.className = 'campout-form';

    const nameField = document.createElement('label');
    nameField.className = 'field grow';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = 'Name';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = campout.name;
    name.required = true;
    nameField.append(nameLabel, name);

    const dateField = document.createElement('label');
    dateField.className = 'field';
    const dateLabel = document.createElement('span');
    dateLabel.textContent = 'Date';
    const date = document.createElement('input');
    date.type = 'date';
    date.value = campout.starts_at || '';
    dateField.append(dateLabel, date);

    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      // Deleting only ungroups; no registration is ever removed.
      if (!window.confirm(
        `Delete "${campout.name}"? Its registrations go back to being ungrouped. `
        + 'No roster data is deleted.')) return;
      try {
        await api(`/api/setup/campouts/${campout.id}`, { method: 'DELETE' });
        await load();
      } catch (error) {
        showError(error.message);
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await api(`/api/setup/campouts/${campout.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: name.value, starts_at: date.value || null }),
        });
        await load();
      } catch (error) {
        showError(error.message);
      } finally {
        save.disabled = false;
      }
    });

    form.append(nameField, dateField, save, remove);
    card.append(form);

    const assigned = state.registration_types.filter((t) => t.campout_id === campout.id);
    if (assigned.length) {
      const list = document.createElement('div');
      list.className = 'assigned-list';
      for (const type of assigned) {
        const row = assignRow(type.line_item_name);
        const count = document.createElement('span');
        count.className = 'muted count';
        count.textContent = countLabel(type.registrations);
        row.append(count);
        list.append(row);
      }
      card.append(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No registrations grouped into this campout yet.';
      card.append(empty);
    }

    container.append(card);
  }
}

async function load() {
  showError('');
  state = await api('/api/setup');
  renderSuggestions();
  renderCampouts();
}

el('new-campout').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/setup/campouts', {
      method: 'POST',
      body: JSON.stringify({
        name: el('new-campout-name').value,
        starts_at: el('new-campout-date').value || null,
      }),
    });
    el('new-campout-name').value = '';
    el('new-campout-date').value = '';
    await load();
  } catch (error) {
    showError(error.message);
  }
});

export { load as loadSetup };
