import { DomainError } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi, createHttpApp, openApiDocument } from '../src/app.ts';

const api = createApi({ version: 'test-sha' });

describe('API', () => {
  it('reports health and the deployed version', async () => {
    const res = await api.request('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'test-sha' });
  });

  it('answers unknown routes with a problem document', async () => {
    const res = await api.request('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 404, code: 'not_found', title: 'Not found' });
  });

  it('maps broken business rules to 422 and hides internal errors', async () => {
    const reported: unknown[] = [];
    const app = createApi({ version: 'x', reportError: (e) => reported.push(e) });
    app.get('/boom/domain', () => {
      throw new DomainError('currency_mismatch', 'Cannot combine USD with EUR');
    });
    app.get('/boom/internal', () => {
      throw new Error('database password is hunter2');
    });

    const domain = await app.request('/boom/domain');
    expect(domain.status).toBe(422);
    expect(await domain.json()).toMatchObject({ code: 'currency_mismatch' });

    const internal = await app.request('/boom/internal');
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain('hunter2');

    // Only the unexpected error reaches error tracking; a broken business rule is not a bug.
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe('database password is hunter2');
  });

  it('serves its own OpenAPI 3.1 contract', async () => {
    const res = await api.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/health');
  });

  it('registers named schemas as reusable components', () => {
    const doc = openApiDocument() as { components?: { schemas?: Record<string, unknown> } };
    expect(doc.components?.schemas).toHaveProperty('Health');
  });

  it('keeps problem documents when mounted under /api', async () => {
    const app = createHttpApp({ version: 'test-sha' });
    expect((await app.request('/api/v1/health')).status).toBe(200);
    const missing = await app.request('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect((await app.request('/api')).status).toBe(404);
  });
});
