# Troop 125 Square Orders Integration

Pulls campout registrations out of Square, parses the scout details hidden in
order modifiers, and publishes them to a **Cloudflare D1 database with a small
password-protected web front end** (and/or a Google Sheet).

## Why the web app exists

Square's Orders API only returns a rolling window of recent orders, and the
old Google Sheets sync overwrote a single tab on every run. Older campouts
scrolled off the end, which is why a fresh sheet had to be created for each
campout by hand.

D1 rows are **upserted and never deleted**, so every campout accumulates in one
place and the front end simply filters by campout name. No more per-campout
sheets.

## Requirements

- Python 3.11+
- A Square account with API credentials
- A Cloudflare account (free tier is sufficient) for the web app

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then fill it in
```

All configuration is via environment variables — see `config.py`. Nothing is
hardcoded in the script.

| Variable | Required for | Notes |
| --- | --- | --- |
| `SQUARE_ACCESS_TOKEN` | always | Square API token |
| `SQUARE_LOCATION_ID` | always | e.g. `LRG8TDY17X9VD` |
| `SQUARE_FETCH_LIMIT` | optional | orders to fetch, default 70 |
| `D1_SYNC_URL` | `--output d1` | `https://…/api/sync` on your Worker |
| `D1_SYNC_TOKEN` | `--output d1` | the Worker's `SYNC_TOKEN` secret |
| `GOOGLE_SHEET_ID` | `--output sheets` | target spreadsheet |
| `GOOGLE_CREDENTIALS_JSON` | `--output sheets` | service account JSON |
| `SHEET_NAME` | optional | default `Sheet1` |
| `WRITE_MODE` | optional | `overwrite` or `append` |

## Usage

```bash
python square_orders.py                  # CSV to stdout (default)
python square_orders.py --output d1      # Cloudflare D1 web app
python square_orders.py --output sheets  # Google Sheets
python square_orders.py --output both    # Sheets + D1, for the migration
```

Use `both` while you are still double-checking the web app against the sheet,
then switch to `d1` and stop maintaining the spreadsheet.

## The web app

Setup instructions live in [`worker/README.md`](worker/README.md). In short:

```bash
cd worker
npm install
npx wrangler d1 create t125-roster    # paste the id into wrangler.toml
npm run db:init
npx wrangler secret put TROOP_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

Leaders visit the Worker URL, enter one shared troop password, pick a campout,
and get a searchable roster with CSV export and a print-friendly view. It works
on a phone.

**Access control is a single shared password.** Sign-in issues an HMAC-signed,
HttpOnly cookie (30 days by default) and failed attempts are rate limited per
IP, but everyone uses the same secret — so treat the URL as sensitive, and
rotate `SESSION_SECRET` (not just the password) when someone leaves the troop,
since that is what invalidates existing sessions immediately.

## Tests

```bash
python test_square_orders.py   # modifier parsing against mock Square data
python test_d1_sync.py         # payload mapping, batching, retry behavior
cd worker && npm test          # auth, session cookies, CSV escaping
```

No test makes a network call. All three run in CI before the sync job.

## Automation

`.github/workflows/nightly-sync.yml` runs hourly except 1am–5am CST, and runs
the test suites before syncing. Configure `D1_SYNC_URL` and `OUTPUT_MODE` as
repository *variables* and `D1_SYNC_TOKEN` as a *secret*.
