import { describe, expect, it } from 'vitest';
import { connectionConfig } from './connection.ts';
import {
  createReadinessProbe,
  describeDatabaseError,
  evaluateRole,
  evaluateTenantIsolation,
  evaluateTls,
  type TableRow,
} from './readiness.ts';

const tables = (overrides: Partial<Record<string, Partial<TableRow>>> = {}): TableRow[] =>
  [
    'approval_steps',
    'audit_events',
    'categories',
    'expenses',
    'extraction_runs',
    'members',
    'mileage_logs',
    'organizations',
    'outbox_events',
    'receipts',
    'reports',
    'trips',
  ].map((table) => ({
    table,
    rls: true,
    forced: table !== 'outbox_events',
    ...overrides[table],
  }));

describe('evaluateRole', () => {
  it('passes only expensewise_app without bypass rights', () => {
    expect(evaluateRole({ role: 'expensewise_app', superuser: false, bypass: false })).toEqual({
      status: 'pass',
      detail: 'connected as expensewise_app',
    });
  });

  it.each([
    [{ role: 'postgres', superuser: false, bypass: true }, /postgres, which bypasses/],
    [{ role: 'supabase_admin', superuser: true, bypass: false }, /bypasses row-level security/],
    [{ role: 'expensewise_relay', superuser: false, bypass: false }, /expected expensewise_app/],
  ])('fails %o', (row, detail) => {
    const check = evaluateRole(row);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(detail);
  });

  it('fails when the role cannot be read', () => {
    expect(evaluateRole(undefined).status).toBe('fail');
  });
});

describe('evaluateTenantIsolation', () => {
  it('passes when every tenant table forces RLS, outbox aside', () => {
    expect(evaluateTenantIsolation(tables())).toEqual({
      status: 'pass',
      detail: 'row-level security enforced on 12 tenant tables',
    });
  });

  it('names tables without enforced RLS', () => {
    const check = evaluateTenantIsolation(
      tables({ expenses: { forced: false }, receipts: { rls: false } }),
    );
    expect(check).toEqual({
      status: 'fail',
      detail: 'row-level security not enforced on: expenses, receipts',
    });
  });

  it('fails when migrations have not run', () => {
    expect(evaluateTenantIsolation([]).detail).toMatch(/found 0 tenant tables.*run migrations/);
  });
});

describe('evaluateTls', () => {
  const check = (url: string) => evaluateTls(url, connectionConfig(url));

  it('passes for Supabase, which is verified against its root certificate', () => {
    expect(
      check('postgresql://expensewise_app.ref:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres')
        .status,
    ).toBe('pass');
  });

  it('skips a local database and fails any other unverified host', () => {
    expect(check('postgres://u:p@127.0.0.1:5432/db').status).toBe('skip');
    expect(check('postgres://u:p@db.example.com:5432/db').status).toBe('fail');
  });
});

describe('describeDatabaseError', () => {
  const coded = (code: string) => Object.assign(new Error(`raw message for ${code}`), { code });

  it.each([
    [coded('28P01'), 'password rejected'],
    [new Error('Failed query', { cause: coded('28P01') }), 'password rejected'],
    [coded('ECONNREFUSED'), 'database unreachable'],
    [coded('ENOTFOUND'), 'database unreachable'],
    [coded('SELF_SIGNED_CERT_IN_CHAIN'), 'TLS verification failed'],
    [new Error('something else'), 'could not connect or query'],
  ])('maps %s to a fixed message', (error, message) => {
    expect(describeDatabaseError(error)).toBe(message);
  });
});

describe('createReadinessProbe', () => {
  it('reports a missing DATABASE_URL without touching anything', async () => {
    const report = await createReadinessProbe(undefined)();
    expect(report.ready).toBe(false);
    expect(report.checks.database).toEqual({ status: 'fail', detail: 'DATABASE_URL is not set' });
    expect(report.checks.role.status).toBe('skip');
  });

  it('reports an unusable connection string without echoing it', async () => {
    const url =
      'postgresql://postgres.ref:[YOUR-PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres';
    const report = await createReadinessProbe(url, { log: () => undefined })();
    expect(report.checks.database.detail).toBe('DATABASE_URL is not a valid connection string');
    expect(JSON.stringify(report)).not.toContain('pooler.supabase.com');
  });

  it('reuses a report within the cache window and refreshes after it', async () => {
    let clock = 0;
    const probe = createReadinessProbe(undefined, { cacheMs: 1_000, now: () => clock });
    const first = probe();
    clock = 999;
    expect(probe()).toBe(first);
    clock = 1_000;
    expect(probe()).not.toBe(first);
    await first;
  });
});
