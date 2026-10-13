import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './helpers/config.js';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** Brings the throwaway test database to the head of the migration chain. */
export default function setup(): void {
  const url = testDatabaseUrl();
  execFileSync('node', [join(SCRIPTS, 'migrate.mjs'), 'up'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
