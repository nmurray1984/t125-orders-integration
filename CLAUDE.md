# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Campout registrations from Square, published to a password-protected web roster.
**Everything in the production path runs on Cloudflare**: a Worker serves the
roster, a cron trigger pulls from Square hourly, and D1 stores the rows. GitHub
holds the code and deploys on push to `main`.

**Why D1 exists**: Square returns only a rolling window of recent orders, and the
old Sheets sync overwrote a single tab each run, so older campouts were lost --
hence the manual "one sheet per campout" workflow it replaced. D1 rows are
upserted and never deleted, so campouts accumulate and the web UI filters by
campout name.

**Two parsers, one behavior**: the modifier-parsing logic exists in Python
(`square_orders.py`, the local CLI) and in JavaScript (`worker/src/extract.js`,
the production path). They are pinned together by `worker/test/fixtures/`,
generated from the Python implementation by `scripts/make_worker_fixture.py` and
asserted byte-identical in CI. Changing parsing rules means changing both and
regenerating the fixtures deliberately.

**Google Sheets has been retired.** `google_sheets.py` and the `sheets`/`both`
output modes were removed once the cron sync landed; recover them from git
history if ever needed.

## Key Commands

### Setup
```bash
pip install -r requirements.txt
```

### Run the Application

The scheduled sync runs on Cloudflare Cron -- nothing needs to be run by hand.
The CLI is for inspecting Square data and manual backfills:

```bash
python square_orders.py --square-env sandbox --check   # verify credentials
python square_orders.py --square-env production        # CSV to stdout
python square_orders.py --square-env production --output d1   # manual backfill
```

Trigger the deployed sync immediately instead of waiting for the cron:

```bash
curl -X POST https://<worker>/api/run-sync -H "Authorization: Bearer <SYNC_TOKEN>"
```

### Run Tests
```bash
python test_square_orders.py   # modifier parsing, mock Square data
python test_d1_sync.py         # D1 payload mapping, batching, Square env selection
cd worker && npm test          # parser port, cron sync, auth, campout dates, CSV
```
All tests use mocks/stubs -- no actual API calls. CI runs all three before any
deploy, and also regenerates the parser fixtures and fails if they drift.

### Worker (local)
```bash
cd worker
npm run db:init:local   # apply schema.sql to the local D1
npm run dev             # wrangler dev, reads secrets from .dev.vars
```

## Architecture

### Core Data Flow

1. **Order Retrieval** (`get_recent_orders()` in square_orders.py:89)
   - Fetches recent orders from Square Orders API
   - Hard-coded location ID: `"LRG8TDY17X9VD"`
   - Configurable fetch limit: `FETCH_LIMIT = 70`

2. **Modifier Extraction** (`extract_modifier_list_ids()` in square_orders.py:14)
   - Extracts catalog object IDs from order line item modifiers
   - Groups modifiers by catalog version (critical for API calls)
   - Returns: `{catalog_version: [object_ids]}`

3. **Modifier Details Retrieval** (`get_modifier_details()` in square_orders.py:29)
   - Fetches modifier metadata using Square Catalog API batch_get
   - Must be called separately per catalog version
   - Returns enriched modifier data including modifier list IDs

4. **Modifier List Resolution** (`get_modifier_list_details()` in square_orders.py:56)
   - Fetches modifier list metadata when modifiers belong to lists
   - Also grouped by catalog version
   - Used to determine the semantic meaning of modifiers (e.g., "Scout Name:", "Rank:")

5. **Data Extraction** (`extract_order_data()` in square_orders.py:103)
   - Transforms raw Square data into structured row format
   - Key logic: Parses modifier names and modifier list names to extract key-value pairs
   - Handles two formats:
     - Modifiers with colons: "Scout Name: John Smith" → extracts both key and value
     - Modifiers with lists: Uses modifier list name as key, modifier name as value
   - Maps to output columns: scout_name, scouter_name, rank, patrol, emergency_contact, emergency_contact_phone, cell_phone, travel_to_campout

6. **Output**
   - `write_csv_to_stdout()`: Writes structured data as CSV to stdout
   - `d1_sync.sync_to_d1()`: Pushes rows to the Worker's `/api/sync`
   - Combines scout_name and scouter_name into single "Name" column
   - Default patrol: "Rocking Chair" if not specified

Note this describes the **CLI** path. Production runs the JavaScript port in
`worker/src/` on a cron trigger; the two are pinned together by the fixtures.

### Square API Integration

**Authentication**: Uses environment variable `SQUARE_ACCESS_TOKEN` (configured in config.py)

**Environment**: selected by `--square-env {sandbox,production}`, defaulting to
`SQUARE_ENVIRONMENT` and then to **sandbox**. The client is built lazily in
`configure_square()` / `get_client()` so importing the module never constructs a
production client. The GitHub Actions sync passes `--square-env production`
explicitly -- changing the default must not silently redirect it.

`--check` verifies credentials by listing the locations a token can see, and
`describe_token()` names common paste errors (Application ID, OAuth secret, stray
whitespace, quoted value) without ever printing the secret. `describe_api_error()`
summarizes Square failures as `HTTP <status>: <detail>` instead of dumping every
response header.

Sandbox and production have separate tokens *and* separate location IDs
(`SQUARE_SANDBOX_ACCESS_TOKEN` / `SQUARE_SANDBOX_LOCATION_ID`); sandbox falls back
to the generic vars when the sandbox-specific ones are unset. Every run prints the
environment, credential source and location to stderr.

**Key APIs Used**:
- `client.orders.search()` - Fetches orders by location
- `client.catalog.batch_get()` - Fetches catalog objects (modifiers/modifier lists)

**Important**: All Catalog API calls must specify `catalog_version` parameter. Each order line item has its own catalog version, and modifiers must be fetched using the correct version.

### Cloudflare D1 / Worker Integration

**Production data flow** (hourly cron): `worker/src/sync.js` -> `square.js`
fetches orders and catalog objects -> `extract.js` parses modifiers ->
`registrations.js` upserts into D1 -> web front end reads them back.

**Manual/CLI data flow**: `square_orders.py` extracts rows -> `d1_sync.build_rows()`
-> batched `POST /api/sync` (bearer `SYNC_TOKEN`) -> the same upsert path.
`POST /api/run-sync` triggers the cron's work on demand with the same token.

**Primary key**: `(order_id, line_item_uid)`. `order_id` alone is NOT unique -- a
single order can register several people, one per line item. `extract_order_data()`
captures `line_item.uid` for this reason.

**Campout partitioning**: `registrations.campout` holds the Square
`line_item_name`, i.e. the *registration type*, not the campout. Square sells one
campout as several catalog items ("Scout Registration - NASA Campout - Oct 2026",
"Scouter Registration - ..."), so the grouping lives in the `campouts` and
`registration_types` tables and is applied at read time via `CAMPOUT_JOIN` /
`CAMPOUT_NAME` in `worker/src/mapping.js`. An unmapped registration type still
shows as its own campout, so the roster works before setup is done.

**Campout setup** (`worker/src/setup.js`, `/setup` page): groups registration
types into campouts and sets their dates. Registration types are listed only from
what the sync has produced rows for -- you cannot map what Square has not sold
yet. Deleting a campout sets its `registration_types.campout_id` to NULL and
never touches `registrations`.

**Campout dates** (`worker/src/campouts.js`): a date configured in setup wins;
otherwise a date is parsed out of the campout name when present (ISO, `Nov 14`, `11/14`,
`November 2026`), with the year inferred as the nearest when omitted. The soonest
future campout is flagged `upcoming` and is what `/` opens on. With no parseable
dates anywhere it falls back to the campout with the most recent signup activity.

**Buyer email**: taken from a fulfillment recipient
(`pickup_details`/`shipment_details`/`delivery_details`), falling back to a
`/v2/customers/{id}` read for orders that carry only a `customer_id`. The
fallback is deduplicated per customer and never fails a sync.

**Schema changes**: `npm run db:init` runs `scripts/migrate.mjs`, which applies
`schema.sql` and then adds any missing columns listed in `ADDED_COLUMNS`. New
columns go in both places -- the `CREATE TABLE` for fresh databases and
`ADDED_COLUMNS` for existing ones. A bare `ALTER TABLE ... ADD COLUMN` in
schema.sql breaks re-runs, since SQLite has no IF NOT EXISTS for columns.

**Upsert semantics**: `first_seen_at` is preserved on conflict; every other column
plus `synced_at` is overwritten. Syncs never delete, so the rolling Square fetch
window cannot drop history.

**Auth** (`worker/src/auth.js`):
- Web UI: one shared `TROOP_PASSWORD`, compared by HMAC (timing-safe, length-blind).
  Success issues an HMAC-signed HttpOnly session cookie; failures are rate limited
  per IP (10 per 15 min) in the `login_attempts` table.
- Sync endpoint: separate `SYNC_TOKEN` bearer header, also compared by HMAC.
- Rotating `TROOP_PASSWORD` does not invalidate live sessions; rotating
  `SESSION_SECRET` does.

**CSV export** guards against spreadsheet formula injection by prefixing cells that
start with `=`, `+`, `-`, or `@` -- roster data is user-supplied via Square modifiers.

### Testing Architecture

**Mock Data** (mock_square_data.py): Complete mock implementations of Square API responses including:
- Mock order objects with line items and modifiers
- Mock catalog objects (modifiers and modifier lists)
- Helper functions that mimic API response structure

**Tests** (test_square_orders.py): Unit tests that exercise individual functions using mock data without API calls.

## Important Implementation Notes

### Catalog Versioning
The Square Catalog uses versioning to track changes over time. When fetching catalog objects:
- Always group object IDs by catalog version (see square_orders.py:33-40, 64-86)
- Make separate batch_get calls for each version
- Mixing versions in a single call will cause errors

### Modifier Data Structure
Modifiers can exist in two forms:
1. **Standalone modifiers**: Simple key-value pairs encoded in the modifier name
2. **List-based modifiers**: Modifier belongs to a modifier_list, where the list provides context
   - Example: Modifier "John Smith" in list "Scout Name:"
   - Requires additional API call to fetch modifier list details

### Data Extraction Logic
The code at square_orders.py:176-191 contains the core mapping logic:
- Extracts keys from modifier list names (e.g., "Scout Name:")
- Combines with modifier values to create semantic data
- Maps known keys to specific output columns

### Default Values
- Empty patrol defaults to "Rocking Chair" (square_orders.py:276)
- Name field prioritizes scout_name over scouter_name (square_orders.py:275)

## Configuration

All configuration is managed through environment variables (see config.py). Set these variables before running the application.

### Required Environment Variables

**For Square API (always required)**:
- `SQUARE_ACCESS_TOKEN`: Square API access token (production)
- `SQUARE_LOCATION_ID`: Square location ID (e.g., "LRG8TDY17X9VD")
- `SQUARE_SANDBOX_ACCESS_TOKEN` / `SQUARE_SANDBOX_LOCATION_ID`: sandbox equivalents
- `SQUARE_ENVIRONMENT`: default for `--square-env` (default: "sandbox")

### Optional Environment Variables

- `SQUARE_FETCH_LIMIT`: Number of orders to fetch (default: 70)

### GitHub Actions

`.github/workflows/deploy.yml` runs the three test suites on every push and PR,
then deploys to Cloudflare on push to `main`. It needs two repository secrets:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

There is no longer a sync workflow -- the sync is a Cloudflare Cron Trigger
(`[triggers] crons` in `worker/wrangler.toml`, handler in `worker/src/sync.js`).

### Cloudflare Worker Setup

See `worker/README.md`. The three Worker secrets are set with `wrangler secret put`:
`TROOP_PASSWORD`, `SESSION_SECRET`, `SYNC_TOKEN`. They are unrelated to each other --
do not reuse one for another.
