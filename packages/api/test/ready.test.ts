import { describe, expect, it, vi } from 'vitest';
import { createApi, type ReadinessProbe } from '../src/app.ts';
import type { Readiness } from '../src/schemas.ts';

const pass = (detail: string) => ({ status: 'pass', detail }) as const;
const ready: Readiness = {
  ready: true,
  checks: {
    database: pass('connected'),
    role: pass('connected as expensewise_app'),
    tls: pass("verified against Supabase's root certificate"),
    tenantIsolation: pass('row-level security enforced on 12 tenant tables'),
  },
};
const notReady: Readiness = {
  ...ready,
  ready: false,
  checks: { ...ready.checks, role: { status: 'fail', detail: 'connected as postgres' } },
};

const get = (readiness?: ReadinessProbe) =>
  createApi({ version: 't', readiness }).request('/v1/health/ready');

describe('GET /v1/health/ready', () => {
  it('answers 200 with the report when every check passes, never cached', async () => {
    const res = await get(() => Promise.resolve(ready));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(ready);
  });

  it('answers 503 with the report when a check fails', async () => {
    const res = await get(() => Promise.resolve(notReady));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(notReady);
  });

  it('answers 503 when no probe is configured', async () => {
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ready: false,
      checks: { database: { status: 'fail', detail: 'readiness is not configured' } },
    });
  });

  it('answers 503, not 500, when the probe throws, without echoing the error', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get(() => Promise.reject(new Error('password for postgres://secret@host')));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('readiness check failed');
    expect(body).not.toContain('secret');
    quiet.mockRestore();
  });

  it('is documented with both outcomes and no auth', async () => {
    const doc = (await (await createApi({ version: 't' }).request('/v1/openapi.json')).json()) as {
      paths: Record<string, { get: { security?: unknown; responses: Record<string, unknown> } }>;
    };
    const route = doc.paths['/v1/health/ready']?.get;
    expect(Object.keys(route?.responses ?? {})).toEqual(['200', '503']);
    expect(route?.security).toBeUndefined();
  });
});
