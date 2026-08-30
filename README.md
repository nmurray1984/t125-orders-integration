# Troop 125 Square Orders Integration

Campout registrations from Square, published to a password-protected web
roster. **Everything runs on Cloudflare**: a Worker serves the roster, a cron
trigger pulls from Square hourly, and D1 stores it. GitHub holds the code and
deploys it on push.

```
Square Orders API
        |  hourly cron trigger
        v
  Cloudflare Worker  --->  D1 (SQLite)
        |
        v
  Web roster (shared troop password)
```

## Why it works this way

Square's Orders API returns only a rolling window of recent orders, and the
old Google Sheets sync overwrote a single tab each run, so older campouts
scrolled off and a fresh sheet had to be made per campout by hand.

D1 rows are **upserted and never deleted**, so campouts accumulate and the
front end filters by campout name.

## Repository layout

| Path | What it is |
| --- | --- |
| `worker/` | everything that runs in production -- Worker, cron sync, web UI, D1 schema |
| `square_orders.py` | local CLI for inspecting Square data and manual backfills |
| `d1_sync.py` | pushes CLI-extracted rows to the Worker |
| `seed_local.py` | fake registrations for local development |
| `scripts/make_worker_fixture.py` | regenerates the fixtures pinning the Worker parser to the Python one |

The Python parser is no longer in the production path -- the Worker has its
own port of it in `worker/src/extract.js`. The two are kept honest by
`worker/test/fixtures/`, generated from the Python implementation and asserted
byte-identical in CI. If you change parsing rules, change them in both and
regenerate.

## Deploying

See [`worker/README.md`](worker/README.md). Once `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are set as GitHub secrets, **pushing to `main` deploys
automatically** after the tests pass.

## The local CLI

Useful for looking at Square data without touching anything:

```bash
pip install -r requirements.txt
cp .env.example .env          # then fill it in

python square_orders.py --square-env sandbox --check     # verify credentials
python square_orders.py --square-env production          # print orders as CSV
```

`--square-env` defaults to **sandbox**; reading production is always
deliberate. Every run prints which environment, credential source and location
it used.

To push a manual backfill into the deployed roster:

```bash
D1_SYNC_URL=https://t125-roster.<subdomain>.workers.dev/api/sync \
D1_SYNC_TOKEN=<your SYNC_TOKEN> \
python square_orders.py --square-env production --output d1
```

You should rarely need this -- the cron does it hourly.

### Environment variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `SQUARE_ACCESS_TOKEN` | CLI | production token |
| `SQUARE_LOCATION_ID` | CLI | e.g. `LRG8TDY17X9VD` |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | sandbox | falls back to the above |
| `SQUARE_SANDBOX_LOCATION_ID` | sandbox | distinct from production |
| `SQUARE_ENVIRONMENT` | optional | default for `--square-env`, default `sandbox` |
| `SQUARE_FETCH_LIMIT` | optional | orders to fetch, default 70 |
| `D1_SYNC_URL` | `--output d1` | the Worker's `/api/sync` |
| `D1_SYNC_TOKEN` | `--output d1` | the Worker's `SYNC_TOKEN` secret |

The Worker reads its own configuration from Cloudflare secrets and vars, not
from `.env`.

## Tests

```bash
python test_square_orders.py   # modifier parsing against mock Square data
python test_d1_sync.py         # payload mapping, batching, Square env selection
cd worker && npm test          # Worker: parser, sync, auth, campout dates, CSV
```

No test makes a network call. All of them run in CI before any deploy.
