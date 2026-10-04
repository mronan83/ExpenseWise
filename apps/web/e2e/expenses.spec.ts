import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SOME_EXPENSE = '/expenses/0192f7a0-0000-7000-8000-0000000000e1';

test.describe('expenses', () => {
  test('opens from Expenses in the main navigation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Expenses' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Expenses' })).toBeVisible();
  });

  test('asks a signed-out visitor to sign in before showing any expense', async ({ page }) => {
    await page.goto('/expenses');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.goto(SOME_EXPENSE);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('refuses the expense endpoints without a signed-in user', async ({ request }) => {
    // 401 with a Supabase project configured; 503 where sign-in is not configured (CI).
    for (const [method, path] of [
      ['GET', '/api/v1/expenses'],
      ['GET', `/api/v1${SOME_EXPENSE}`],
      ['PATCH', `/api/v1${SOME_EXPENSE}`],
    ] as const) {
      const res = await request.fetch(path, {
        method,
        data: method === 'PATCH' ? { amount: '1.00' } : undefined,
      });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });

  test('asks a signed-out visitor to sign in before adding mileage, and refuses its endpoints', async ({
    page,
    request,
  }) => {
    await page.goto('/mileage/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Add mileage' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    for (const [method, path] of [
      ['GET', '/api/v1/mileage/quote?date=2026-09-22&miles=3'],
      ['POST', '/api/v1/mileage'],
      ['GET', `/api/v1/mileage/${SOME_EXPENSE.split('/').at(-1)}`],
      ['PATCH', `/api/v1/mileage/${SOME_EXPENSE.split('/').at(-1)}`],
    ] as const) {
      const res = await request.fetch(path, {
        method,
        data: method === 'GET' ? undefined : { miles: '3' },
      });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`expenses accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const path of ['/expenses', SOME_EXPENSE]) {
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
