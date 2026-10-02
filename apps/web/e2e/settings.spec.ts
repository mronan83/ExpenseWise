import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('sign-in and AI provider settings', () => {
  test('links to settings from the home page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();
  });

  test('asks a signed-out visitor to sign in before showing any keys', async ({ page }) => {
    await page.goto('/settings/ai');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel(/API key/)).toHaveCount(0);
  });

  test('serves the sign-in page', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('refuses the key endpoints without a signed-in user', async ({ request }) => {
    // 401 with a Supabase project configured; 503 where sign-in is not configured (CI).
    for (const [method, path] of [
      ['GET', '/api/v1/settings/ai-providers'],
      ['PUT', '/api/v1/settings/ai-providers/anthropic'],
      ['POST', '/api/v1/me/organization'],
    ] as const) {
      const res = await request.fetch(path, {
        method,
        data: method === 'PUT' ? { apiKey: 'x' } : undefined,
      });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`settings accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const path of ['/sign-in', '/settings/ai']) {
      test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}
