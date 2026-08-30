# Troop 125 Roster Worker

Cloudflare Worker + D1 database + a single-page front end that replaces the
per-campout Google Sheet. The Square sync (`../square_orders.py`) pushes rows
here; leaders sign in with one shared troop password and pick a campout.

## Why the sheet went away

The Square fetch only ever sees a rolling window of recent orders. A sheet that
gets overwritten each run therefore loses older campouts, which is why a new
sheet had to be made each time. D1 rows are **upserted and never deleted**, so
every campout stays queryable and the front end just filters by campout name.

## One-time setup

```bash
cd worker
npm install

# 1. Create the database, then paste the printed id into wrangler.toml
npx wrangler d1 create t125-roster

# 2. Create the tables
npm run db:init

# 3. Set the three secrets
npx wrangler secret put TROOP_PASSWORD   # what your leaders type in
npx wrangler secret put SESSION_SECRET   # any long random string, see below
npx wrangler secret put SYNC_TOKEN       # any long random string, see below

# 4. Ship it
npm run deploy
```

Generate the two random values with:

```bash
openssl rand -base64 32
```

`SESSION_SECRET` signs the login cookie and `SYNC_TOKEN` authenticates the
GitHub Actions sync. They are unrelated to each other and to the troop
password — do not reuse one for another.

## Point the sync at it

Add these to the repo's GitHub Actions config:

| Where | Name | Value |
| --- | --- | --- |
| Variables | `D1_SYNC_URL` | `https://t125-roster.<subdomain>.workers.dev/api/sync` |
| Secrets | `D1_SYNC_TOKEN` | the `SYNC_TOKEN` you set above |
| Variables | `OUTPUT_MODE` | `both` while migrating, then `d1` |

## Rotating the password

```bash
npx wrangler secret put TROOP_PASSWORD
```

That takes effect immediately for new sign-ins, but **existing cookies stay
valid for up to 30 days**. To force everyone out — someone leaves the troop,
say — rotate `SESSION_SECRET` too, which invalidates every session instantly.

## Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/login` | password in body, rate limited per IP |
| `POST` | `/api/logout` | — |
| `GET` | `/api/session` | — (reports whether the cookie is valid) |
| `GET` | `/api/campouts` | session cookie |
| `GET` | `/api/roster?campout=` | session cookie |
| `GET` | `/api/export.csv?campout=` | session cookie |
| `POST` | `/api/sync` | `Authorization: Bearer <SYNC_TOKEN>` |

## Local development

```bash
npm run db:init:local
npm run dev
```

`wrangler dev` reads secrets from a `.dev.vars` file (git-ignored):

```
TROOP_PASSWORD=localdev
SESSION_SECRET=localdev-secret
SYNC_TOKEN=localdev-token
```

## Tests

```bash
npm test
```

Covers password comparison, session cookie forgery and expiry, sync-token
checking, and CSV escaping/formula-injection handling.
