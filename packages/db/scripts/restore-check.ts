/**
 * The database checks of the monthly restore drill (scripts/backup/restore-drill.sh), run
 * against a throwaway database the drill has just restored the nightly dump into:
 *
 *   RESTORE_DATABASE_URL=… DRILL_MANIFEST=…/manifest.json pnpm --filter @expensewise/db restore:check
 *
 * RESTORE_DATABASE_URL connects as that database's postgres role, as a restore into a new
 * Supabase project would. Never point it at production: it applies migrations and sets the
 * runtime roles' passwords. Prints one line per check and exits 1 if any fails.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionConfig } from '../src/connection.ts';
import {
  bringForward,
  checkIsolation,
  checkMigrations,
  checkRowCounts,
  checkRowSecurity,
  checkSchema,
  type DrillCheck,
  type DumpManifest,
} from '../src/restore-drill.ts';
import { roleConnectionString, setRolePasswords } from '../src/role-passwords.ts';
import type { SchemaSnapshot } from '../src/schema-snapshot.ts';

const url = process.env.RESTORE_DATABASE_URL;
const manifestPath = process.env.DRILL_MANIFEST;
if (!url || !manifestPath) {
  console.error('Set RESTORE_DATABASE_URL (the throwaway database) and DRILL_MANIFEST.');
  process.exit(1);
}
const { hostname } = new URL(url);
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
  console.error('RESTORE_DATABASE_URL must be a database on this machine, never production.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DumpManifest;
const expected = JSON.parse(
  readFileSync(fileURLToPath(new URL('../schema.json', import.meta.url)), 'utf8'),
) as SchemaSnapshot;

const results: DrillCheck[] = [];
const report = (result: DrillCheck) => {
  results.push(result);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.check}: ${result.detail}`);
};

const owner = new pg.Client(connectionConfig(url));
await owner.connect();
try {
  // Counts first: bringing the data forward may add rows of its own.
  report(await checkRowCounts(owner, manifest));
  const migrations = await checkMigrations(owner, manifest);
  report(migrations);
  const applied = Number(
    (await owner.query<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations'))
      .rows[0]!.n,
  );
  const forward = await bringForward(url, applied);
  report(forward);
  if (forward.ok) {
    report(await checkSchema(owner, expected));
    report(await checkRowSecurity(owner));
    // The runtime roles come back without passwords; the Release run sets them after a real
    // restore. Here they get throwaway ones.
    const passwords = {
      expensewise_app: randomBytes(24).toString('hex'),
      expensewise_relay: randomBytes(24).toString('hex'),
    };
    await setRolePasswords(owner, passwords);
    report(
      await checkIsolation(
        owner,
        roleConnectionString(url, 'expensewise_app', passwords.expensewise_app),
      ),
    );
  }
} finally {
  await owner.end();
}

const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.log(`${failed} of ${results.length} database checks failed.`);
  process.exit(1);
}
console.log(`All ${results.length} database checks passed.`);
