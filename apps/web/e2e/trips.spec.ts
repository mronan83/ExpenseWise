import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SOME_TRIP = '/trips/0192f7a0-0000-7000-8000-0000000000c1';
const SOME_EXPENSE = '/expenses/0192f7a0-0000-7000-8000-0000000000e1';

test.describe('trips', () => {
  test('opens from Trips in the main navigation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Trips' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  });

  test('asks a signed-out visitor to sign in before showing any trip', async ({ page }) => {
    await page.goto('/trips');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.goto(SOME_TRIP);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('refuses the trip endpoints without a signed-in user', async ({ request }) => {
    // 401 with a Supabase project configured; 503 where sign-in is not configured (CI).
    for (const [method, path, data] of [
      ['GET', '/api/v1/trips', undefined],
      ['POST', '/api/v1/trips', { name: 'x', startDate: '2026-10-05', endDate: '2026-10-07' }],
      ['GET', `/api/v1${SOME_TRIP}`, undefined],
      ['PATCH', `/api/v1${SOME_TRIP}`, { name: 'x' }],
      ['DELETE', `/api/v1${SOME_TRIP}`, undefined],
      ['PUT', `/api/v1${SOME_EXPENSE}/trip`, { tripId: null }],
    ] as const) {
      const res = await request.fetch(path, { method, data });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`trips accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const path of ['/trips', SOME_TRIP]) {
      test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}
