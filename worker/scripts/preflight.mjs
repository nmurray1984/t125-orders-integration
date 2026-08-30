/**
 * Runs before `npm run deploy`.
 *
 * `wrangler deploy` happily accepts the placeholder database_id and fails
 * later at runtime, which is a confusing way to find out. Catch it here, and
 * print the steps that are easy to forget.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'wrangler.toml'), 'utf8');

const problems = [];

if (config.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID')) {
  problems.push(
    'wrangler.toml still has the placeholder database_id.\n' +
    '    Run:   npx wrangler d1 create t125-roster\n' +
    '    Then paste the printed database_id into wrangler.toml.',
  );
}

if (problems.length) {
  console.error('\nCannot deploy yet:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(`
Deploying. Make sure these are done (each is safe to re-run):

  npm run db:init                        create the tables in the remote D1
  npx wrangler secret put TROOP_PASSWORD what leaders type in
  npx wrangler secret put SESSION_SECRET signs the login cookie
  npx wrangler secret put SYNC_TOKEN     authenticates the GitHub Actions sync

The Worker returns 503 with the missing names if a secret is not set.
`);
