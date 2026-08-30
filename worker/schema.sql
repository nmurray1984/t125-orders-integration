-- Troop 125 campout registrations, synced from Square.
--
-- The Square sync fetches a rolling window of recent orders, so this table is
-- append/upsert only -- rows are never deleted by a sync. That is what lets
-- past campouts stay queryable instead of scrolling off the end of the window.

CREATE TABLE IF NOT EXISTS registrations (
  order_id                TEXT NOT NULL,
  line_item_uid           TEXT NOT NULL,
  campout                 TEXT NOT NULL DEFAULT '',
  variation_name          TEXT NOT NULL DEFAULT '',
  name                    TEXT NOT NULL DEFAULT '',
  scout_name              TEXT NOT NULL DEFAULT '',
  scouter_name            TEXT NOT NULL DEFAULT '',
  rank                    TEXT NOT NULL DEFAULT '',
  patrol                  TEXT NOT NULL DEFAULT '',
  emergency_contact       TEXT NOT NULL DEFAULT '',
  emergency_contact_phone TEXT NOT NULL DEFAULT '',
  cell_phone              TEXT NOT NULL DEFAULT '',
  travel_to_campout       TEXT NOT NULL DEFAULT '',
  total_money             TEXT NOT NULL DEFAULT '',
  order_created_at        TEXT NOT NULL DEFAULT '',
  first_seen_at           TEXT NOT NULL DEFAULT '',
  synced_at               TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (order_id, line_item_uid)
);

CREATE INDEX IF NOT EXISTS idx_registrations_campout
  ON registrations (campout);

CREATE INDEX IF NOT EXISTS idx_registrations_order_created
  ON registrations (order_created_at DESC);

-- One row per successful sync, so the UI can show "last updated" the way the
-- LastUpdate!A1 cell did in the Sheets version.
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at   TEXT NOT NULL,
  rows_seen   INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sync_log_synced_at
  ON sync_log (synced_at DESC);

-- Per-IP throttle for the shared-password login. A shared password is only as
-- good as the rate limit in front of it.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  attempts      INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL DEFAULT 0
);

-- A campout as the troop thinks of it. Square has no such concept: one campout
-- is sold as several catalog items ("Scout Registration - NASA Campout -
-- Oct 2026", "Scouter Registration - ..."), so the grouping has to be recorded
-- here rather than inferred from a name.
CREATE TABLE IF NOT EXISTS campouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  -- YYYY-MM-DD. Null falls back to a date parsed out of the name.
  starts_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);

-- Maps a Square line item name to a campout. Rows appear here only for
-- registration types that have actually been synced -- you can only map what
-- Square has shown you.
CREATE TABLE IF NOT EXISTS registration_types (
  line_item_name TEXT PRIMARY KEY,
  campout_id     INTEGER REFERENCES campouts(id) ON DELETE SET NULL,
  assigned_at    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_registration_types_campout
  ON registration_types (campout_id);
