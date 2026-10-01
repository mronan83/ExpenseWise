import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('app shell', () => {
  test('opens on the inbox with the five-destination tab bar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of ['Home', 'Expenses', 'Capture', 'Trips', 'Reports']) {
      await expect(nav.getByText(label, { exact: true })).toBeAttached();
    }
    await expect(nav.getByText('Home', { exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('sends security headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['permissions-policy']).toContain('camera=(self)');
    expect(res.headers()['x-powered-by']).toBeUndefined();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('has no WCAG 2.2 AA violations', async ({ page }) => {
      await page.goto('/');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test.describe('API through Next.js', () => {
  test('serves health and the OpenAPI contract under /api', async ({ request }) => {
    const health = await request.get('/api/v1/health');
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const contract = await request.get('/api/v1/openapi.json');
    expect(contract.status()).toBe(200);
    expect((await contract.json()) as { openapi: string }).toMatchObject({ openapi: '3.1.0' });
  });

  test('reports readiness with a status that matches the report', async ({ request }) => {
    // E2E runs without the production database, so this checks the wiring, not a pass.
    const res = await request.get('/api/v1/health/ready');
    const report = (await res.json()) as { ready: boolean; checks: Record<string, unknown> };
    expect(res.status()).toBe(report.ready ? 200 : 503);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(Object.keys(report.checks)).toEqual(['database', 'role', 'tls', 'tenantIsolation']);
  });

  test('answers unknown API routes with a problem document', async ({ request }) => {
    const res = await request.get('/api/v1/does-not-exist');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/problem+json');
  });
});
