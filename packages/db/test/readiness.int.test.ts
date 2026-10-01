import { inject } from 'vitest';
import { describe, expect, it } from 'vitest';
import { createReadinessProbe } from '../src/readiness.ts';

const quiet = { log: () => undefined, cacheMs: 0 };

describe('readiness probe against Postgres', () => {
  it('is ready as expensewise_app on a migrated database', async () => {
    const report = await createReadinessProbe(inject('appUrl'), quiet)();
    expect(report.checks).toEqual({
      database: { status: 'pass', detail: 'connected' },
      role: { status: 'pass', detail: 'connected as expensewise_app' },
      tls: { status: 'skip', detail: 'local database; TLS not required' },
      tenantIsolation: {
        status: 'pass',
        detail: expect.stringMatching(
          /^row-level security enforced on \d+ tenant tables$/,
        ) as string,
      },
    });
    expect(report.ready).toBe(true);
  });

  it('is not ready as a role that bypasses row-level security', async () => {
    const report = await createReadinessProbe(inject('ownerUrl'), quiet)();
    expect(report.ready).toBe(false);
    expect(report.checks.role.status).toBe('fail');
    expect(report.checks.role.detail).toMatch(/bypasses row-level security/);
  });

  it('is not ready as the relay role', async () => {
    const report = await createReadinessProbe(inject('relayUrl'), quiet)();
    expect(report.checks.role).toEqual({
      status: 'fail',
      detail: 'connected as expensewise_relay; expected expensewise_app',
    });
  });

  it('reports a wrong password without echoing the connection string', async () => {
    const url = new URL(inject('appUrl'));
    url.password = 'not-the-password';
    const report = await createReadinessProbe(url.toString(), quiet)();
    expect(report.checks.database).toEqual({ status: 'fail', detail: 'password rejected' });
    expect(JSON.stringify(report)).not.toContain('not-the-password');
  });

  it('reports an unreachable database quickly', async () => {
    const started = Date.now();
    const report = await createReadinessProbe('postgres://u:p@127.0.0.1:1/db', quiet)();
    expect(report.checks.database).toEqual({ status: 'fail', detail: 'database unreachable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
