# Troop 125 Roster Worker

Cloudflare Worker + D1 database + a single-page front end that replaces the
per-campout Google Sheet. The Square sync (`../square_orders.py`) pushes rows
here; leaders sign in with one shared troop password and pick a campout.

## Why the sheet went away

The Square fetch only ever sees a rolling window of recent orders. A sheet that
gets overwritten each run therefore loses older campouts, which is why a new
sheet had to be made each time. D1 rows are **upserted and never deleted**, so
every campout stays queryable and the front end just filters by campout name.

## Deploying

### 1. Connect wrangler to your Cloudflare account

```bash
cd worker
npm install
npx wrangler login
```

That opens a browser to authorize. `npx wrangler whoami` confirms which account
you are on.

### 2. Create the database

```bash
npx wrangler d1 create t125-roster
```

It prints a `database_id`. **Paste it into `wrangler.toml`**, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Do this before step 3 -- every *remote* D1 command needs the real id, and
skipping it produces `Invalid property: databaseId => Invalid uuid`, which does
not obviously mean "you missed a step". `npm run db:init` and `npm run deploy`
both refuse to run until it is filled in.

Already created the database and lost the id?

```bash
npx wrangler d1 list
```

Local commands are unaffected -- they resolve the database by name, which is
why `db:init:local` works without it.

### 3. Create the tables

```bash
npm run db:init
```

This is the remote database. `db:init:local` is the local one -- different
database, and easy to confuse. Safe to re-run; every statement is
`CREATE TABLE IF NOT EXISTS`.

### 4. Set the three secrets

```bash
npx wrangler secret put TROOP_PASSWORD   # what leaders type in
npx wrangler secret put SESSION_SECRET   # long random string
npx wrangler secret put SYNC_TOKEN       # long random string
```

Generate the two random ones:

```bash
openssl rand -base64 32
```

They are unrelated to each other and to the troop password -- do not reuse one
for another. Keep a copy of `SYNC_TOKEN`; GitHub Actions needs it next.

### 5. Deploy

```bash
npm run deploy
```

It prints your URL, something like
`https://t125-roster.<your-subdomain>.workers.dev`. Open it and sign in with
`TROOP_PASSWORD`. The roster will be empty until the first sync.

### 6. Point the nightly sync at it

In GitHub: **Settings → Secrets and variables → Actions**.

| Tab | Name | Value |
| --- | --- | --- |
| Variables | `D1_SYNC_URL` | `https://t125-roster.<subdomain>.workers.dev/api/sync` |
| Variables | `OUTPUT_MODE` | `both` at first, then `d1` |
| Secrets | `D1_SYNC_TOKEN` | the `SYNC_TOKEN` from step 4 |

Note the `/api/sync` on the end of the URL.

### 7. Load it now instead of waiting for the schedule

Either trigger the workflow by hand (Actions tab → the sync workflow → Run
workflow), or push from your machine:

```bash
cd ..
D1_SYNC_URL=https://t125-roster.<subdomain>.workers.dev/api/sync \
D1_SYNC_TOKEN=<your SYNC_TOKEN> \
python square_orders.py --square-env production --output d1
```

`--square-env production` matters: the CLI defaults to sandbox, and you do not
want test scouts in the real roster.

## Deploying again later

```bash
npm run deploy
```

Code only. Secrets and data are untouched. If you changed `schema.sql`, run
`npm run db:init` too.

## If something is wrong

| Symptom | Cause |
| --- | --- |
| 503, "Worker is not configured. Missing: ..." | that secret is not set -- step 4 |
| "database error: no such table: registrations" | step 3 was skipped, or ran locally |
| Sync returns 401 | `D1_SYNC_TOKEN` does not match the Worker's `SYNC_TOKEN` |
| Login page but the password is refused | 10 wrong tries per IP per 15 min; wait, or clear `login_attempts` |
| Empty roster after a sync | check the sync ran against `--square-env production` |

Read the remote database directly when in doubt:

```bash
npx wrangler d1 execute t125-roster --remote \
  --command "SELECT campout, COUNT(*) FROM registrations GROUP BY campout"
```

## Custom domain (optional)

A `workers.dev` URL works fine. To use your own, add the domain to Cloudflare,
then in the dashboard: Workers & Pages → t125-roster → Settings → Domains &
Routes → Add custom domain. TLS is automatic.

## Cost

Nothing, at troop scale. The free tier covers 100k Worker requests/day and
5 GB / 5M row reads / 100k row writes per day on D1; an hourly sync of ~70
registrations uses a tiny fraction of that.

## Rotating the password

```bash
npx wrangler secret put TROOP_PASSWORD
```

That takes effect immediately for new sign-ins, but **existing cookies stay
valid for up to 30 days**. To force everyone out — someone leaves the troop,
say — rotate `SESSION_SECRET` too, which invalidates every session instantly.

## Pages

Each campout has its own URL, so a page can be bookmarked or texted to another
leader:

| Path | Shows |
| --- | --- |
| `/` | redirects to the upcoming campout |
| `/c/<campout name>` | that campout |
| `/c/all` | every campout at once |

The page leads with a headcount: one hero total plus a tile per patrol, for
meal planning. Below that is the roster, alphabetical by default and sortable
by patrol, rank, or signup date. On a phone each registration becomes a card
with the name and tags (rank, patrol, and an "Own transport" flag) leading.

### How "upcoming" is decided

Square does not tell us when a campout happens -- only the catalog item name
and when each order was paid. So `src/campouts.js` reads a date out of the
name where there is one:

| Name | Reads as |
| --- | --- |
| `Fall Camporee - Nov 14-16` | Nov 14, year inferred as the nearest |
| `Winter Klondike Jan 9, 2027` | Jan 9 2027 |
| `2026-11-14 Klondike` | Nov 14 2026 |
| `Camporee 11/14` | Nov 14, year inferred |
| `November 2026 Campout` | Nov 1 2026 |
| `Caving Trip` | no date |

The soonest campout still in the future is the upcoming one. **When no name
has a parseable date, it falls back to whichever campout has the most recent
signup activity** -- the one people are paying for now is almost always the
next one. That fallback is a guess; naming campouts with a date in Square
makes it exact.

## Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/login` | password in body, rate limited per IP |
| `POST` | `/api/logout` | — |
| `GET` | `/api/session` | — (reports whether the cookie is valid) |
| `GET` | `/api/campouts` | session cookie; returns `starts_at`, `is_past`, `upcoming` |
| `GET` | `/api/roster?campout=` | session cookie; returns rows + per-patrol headcounts |
| `GET` | `/api/export.csv?campout=` | session cookie |
| `POST` | `/api/sync` | `Authorization: Bearer <SYNC_TOKEN>` |

## Local development

Everything runs on your machine -- no Cloudflare account, no deploy, no Square
credentials. `wrangler dev --local` runs the real Worker runtime against a
SQLite file under `.wrangler/`.

```bash
cd worker
npm install

# 1. Secrets for local only. This file is git-ignored; these values are fake.
cat > .dev.vars <<'EOF'
TROOP_PASSWORD=localdev
SESSION_SECRET=localdev-session-secret
SYNC_TOKEN=localdev-sync-token
EOF

# 2. Create the local tables
npm run db:init:local

# 3. Start it
npm run dev
```

Then, in a second terminal, load some fake registrations:

```bash
python seed_local.py
```

Open http://127.0.0.1:8787 and sign in with `localdev`.

### Using real Square data locally

Put your Square credentials in `.env` at the repo root:

```
SQUARE_ACCESS_TOKEN=your_token
SQUARE_LOCATION_ID=LRG8TDY17X9VD
```

Have a look at what Square returns before writing anything -- this touches no
database:

```bash
python square_orders.py --output stdout
```

Then, with `npm run dev` running in `worker/`, load it into the local database:

```bash
D1_SYNC_URL=http://127.0.0.1:8787/api/sync \
D1_SYNC_TOKEN=localdev-sync-token \
python square_orders.py --output d1
```

`D1_SYNC_URL` normally has to be https, since the sync token travels as a
bearer header. http is accepted only when the host is `localhost`, `127.0.0.1`
or `::1`, where the request never leaves the machine. A remote http URL is
still refused.

This writes to your **local** SQLite file under `.wrangler/`, not to
Cloudflare -- deployed data is only touched by a Worker you have deployed.

Real Square data means real scouts' phone numbers and emergency contacts on
your laptop. `rm -rf .wrangler` when you are done, or use `seed_local.py`
instead when you only need to check a layout.

### "Signed in, but your browser did not keep the session cookie"

The session cookie is marked `Secure` only when the request came over https, so
local http works in every browser. If you still see this, something in the
browser is blocking cookies for the site -- check for a strict privacy setting
or an extension, or try a private window.

### If you lock yourself out

Local requests have no `CF-Connecting-IP`, so every one of them shares a single
`unknown` IP. A few wrong password guesses will throttle you for 15 minutes.
Clear it with:

```bash
npx wrangler d1 execute t125-roster --local --command "DELETE FROM login_attempts"
```

### "This Worker requires compatibility date ..."

```
✘ [ERROR] service core:user:t125-roster: This Worker requires compatibility
  date "2026-08-01", but the newest date supported by this server binary is ...
```

Your wrangler is older than the `compatibility_date` in `wrangler.toml`. The
date is deliberately conservative, so if you still hit this, either lower it to
a date your wrangler supports or upgrade:

```bash
npm install --save-dev wrangler@latest
```

Check what you have with `npx wrangler --version`.

### Resetting

```bash
rm -rf .wrangler && npm run db:init:local
```

## Tests

```bash
npm test
```

Covers password comparison, session cookie forgery and expiry, sync-token
checking, and CSV escaping/formula-injection handling.
