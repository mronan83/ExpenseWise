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

  test('asks a signed-out visitor to sign in before showing sign-ins', async ({ page }) => {
    await page.goto('/settings/sign-ins');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign-ins' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await page.getByRole('link', { name: 'AI providers' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();
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
      ['GET', '/api/v1/me/sign-ins'],
      ['POST', '/api/v1/me/sign-ins'],
      ['GET', '/api/v1/features'],
      ['PUT', '/api/v1/settings/features/expenses.mileage'],
      ['GET', '/api/v1/audit/events'],
      ['GET', '/api/v1/audit/verification'],
      ['GET', '/api/v1/settings/organization'],
      ['PATCH', '/api/v1/settings/organization'],
      ['GET', '/api/v1/settings/duplicate-window'],
      ['PUT', '/api/v1/settings/duplicate-window'],
    ] as const) {
      const res = await request.fetch(path, {
        method,
        data: method === 'GET' ? undefined : { apiKey: 'x', accessToken: 'x', enabled: true },
      });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`settings accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const path of [
      '/sign-in',
      '/settings/ai',
      '/settings/sign-ins',
      '/settings/features',
      '/settings/audit',
      '/settings/organization',
    ]) {
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
