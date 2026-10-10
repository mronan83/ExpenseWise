import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SOME_RECEIPT = '/receipts/0192f7a0-0000-7000-8000-0000000000d1';

test.describe('receipts', () => {
  test('opens from the Capture button on the home page', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Capture' })
      .click();
    // Capture opens every way in, a receipt photo first, and Receipts beneath (FR-CAP-12).
    const menu = page.getByRole('dialog', { name: 'Bring something in' });
    await expect(menu.getByText('Take a photo of a receipt')).toBeVisible();
    await menu.getByRole('link', { name: 'See all receipts' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
  });

  test('takes a photo straight from the Capture menu: its choice is the camera itself', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Capture' })
      .click();
    // One tap on the choice opens the camera: + and the photo are two taps from any screen.
    const photo = page
      .getByRole('dialog', { name: 'Bring something in' })
      .getByLabel('Take a photo of a receipt');
    await expect(photo).toHaveAttribute('type', 'file');
    await expect(photo).toHaveAttribute('capture', 'environment');
    await expect(photo).toHaveAttribute('accept', 'image/*');
  });

  test('offers only receipts while no feature is on, as when signed out', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Capture' })
      .click();
    const menu = page.getByRole('dialog', { name: 'Bring something in' });
    await expect(menu.getByText('Upload a receipt')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(menu.getByText('Add a drive')).toHaveCount(0);
    await expect(menu.getByText('Bring in a card statement')).toHaveCount(0);
    await expect(menu.getByText('Bring in a downloaded list')).toHaveCount(0);
  });

  test('closes the Capture menu on Escape, handing focus back to Capture', async ({ page }) => {
    await page.goto('/');
    const capture = page.getByRole('navigation', { name: 'Main' }).getByRole('button', {
      name: 'Capture',
    });
    await capture.click();
    await expect(page.getByRole('dialog', { name: 'Bring something in' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Bring something in' })).toBeHidden();
    await expect(capture).toBeFocused();
  });

  test('asks a signed-out visitor to sign in before showing any receipts', async ({ page }) => {
    await page.goto('/receipts');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Take a photo')).toHaveCount(0);
    await page.goto(SOME_RECEIPT);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('refuses the receipt endpoints without a signed-in user', async ({ request }) => {
    // 401 with a Supabase project configured; 503 where sign-in is not configured (CI).
    for (const [method, path] of [
      ['GET', '/api/v1/receipts'],
      ['POST', '/api/v1/receipts/uploads'],
      ['POST', '/api/v1/receipts'],
      ['GET', `/api/v1${SOME_RECEIPT}`],
      ['POST', `/api/v1${SOME_RECEIPT}/read`],
    ] as const) {
      const res = await request.fetch(path, { method, data: method === 'POST' ? {} : undefined });
      expect([401, 503]).toContain(res.status());
      expect(res.headers()['content-type']).toContain('application/problem+json');
    }
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`receipts accessibility in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const path of ['/receipts', SOME_RECEIPT]) {
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
