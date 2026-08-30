/**
 * Runs before `npm run deploy` and before `npm run db:init`.
 *
 * Any remote D1 command needs a real database_id. `wrangler deploy` accepts
 * the placeholder and fails later at runtime; `d1 execute --remote` fails with
 * "Invalid uuid", which does not obviously mean "you skipped a step". Catch it
 * at whichever command comes first.
 *
 * Local commands are unaffected -- they resolve the database by name, which is
 * why `db:init:local` works before the id is filled in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'wrangler.toml'), 'utf8');

const problems = [];

// In CI there is nobody to answer an interactive login prompt, and wrangler's
// own error arrives only after the upload starts. Say it up front instead.
if (process.env.CI && process.env.npm_lifecycle_event === 'predeploy') {
  const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
    .filter((name) => !process.env[name]);

  if (missing.length) {
    problems.push(
      `${missing.join(' and ')} not set in this CI run.\n\n` +
      '    Add them under Settings > Secrets and variables > Actions > Secrets:\n' +
      '      CLOUDFLARE_API_TOKEN   Cloudflare dashboard > My Profile > API Tokens\n' +
      '                             > Create Token > "Edit Cloudflare Workers"\n' +
      '      CLOUDFLARE_ACCOUNT_ID  Cloudflare dashboard > Workers & Pages sidebar',
    );
  }
}

if (config.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID')) {
  problems.push(
    'wrangler.toml still has the placeholder database_id.\n\n' +
    '    If you have not created the database yet:\n' +
    '      npx wrangler d1 create t125-roster\n\n' +
    '    If you already created it, look up the id:\n' +
    '      npx wrangler d1 list\n\n' +
    '    Then paste that uuid into wrangler.toml, replacing\n' +
    '    REPLACE_WITH_YOUR_D1_DATABASE_ID.',
  );
}

if (problems.length) {
  const action = process.env.npm_lifecycle_event === 'predeploy' ? 'deploy' : 'run that yet';
  console.error(`\nCannot ${action}:\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

// Only the deploy path needs the reminder; db:init is a single step.
if (process.env.npm_lifecycle_event === 'predeploy') {
  console.log(`
Deploying. Make sure these are done (each is safe to re-run):

  npm run db:init                        create the tables in the remote D1
  npx wrangler secret put TROOP_PASSWORD what leaders type in
  npx wrangler secret put SESSION_SECRET signs the login cookie
  npx wrangler secret put SYNC_TOKEN     authenticates the GitHub Actions sync

The Worker returns 503 with the missing names if a secret is not set.
`);
}
