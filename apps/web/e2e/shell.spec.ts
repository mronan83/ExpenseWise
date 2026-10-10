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

  test('shows the tab bar on every screen but sign-in, marking where you are', async ({ page }) => {
    for (const [path, current] of [
      ['/expenses', 'Expenses'],
      ['/trips', 'Trips'],
      ['/receipts', 'Capture'],
      ['/settings/ai', null],
    ] as const) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav).toBeVisible();
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(current ? 1 : 0);
      if (current) {
        await expect(nav.locator('[aria-current="page"]')).toContainText(current);
      }
    }
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('keeps two date fields side by side inside a narrow card', async ({ page }) => {
    // iOS Safari gives a native date field a minimum width of its own; the app turns the
    // native look off so the field fits its column (globals.css).
    await page.goto('/');
    const boxes = await page.evaluate(() => {
      const row = document.createElement('div');
      row.className = 'grid grid-cols-2 gap-3';
      row.style.width = '260px';
      row.innerHTML = ['From', 'To']
        .map(
          (label) =>
            `<label class="flex min-w-0 flex-col">${label}<input type="date" value="2026-09-30" class="w-full min-w-0 rounded-lg border px-3 py-2 text-base"></label>`,
        )
        .join('');
      document.querySelector('main')!.append(row);
      const [from, to] = [...row.querySelectorAll('input')].map((input) => ({
        box: input.getBoundingClientRect().toJSON() as DOMRect,
        appearance: getComputedStyle(input).appearance,
      }));
      return { row: row.getBoundingClientRect().toJSON() as DOMRect, from: from!, to: to! };
    });
    expect(boxes.from.appearance).toBe('none');
    expect(boxes.from.box.right).toBeLessThanOrEqual(boxes.to.box.left);
    expect(boxes.to.box.right).toBeLessThanOrEqual(boxes.row.right + 0.5);
  });

  test('ships the build-version change dark: its flag is off by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText(/^build /)).toHaveCount(0);
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

/** WCAG contrast of two colors given as #rrggbb. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(bl!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The PNG's width and height, from its header. */
const pngSize = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test.describe('the Carbon identity (ADR-0049)', () => {
  test('names its icons in the manifest and serves each one, the iPhone’s too', async ({
    request,
  }) => {
    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.icons.map((i) => i.sizes)).toEqual(['any', '192x192', '512x512', '512x512']);
    for (const icon of manifest.icons) {
      const res = await request.get(icon.src);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toContain(icon.type);
      if (icon.type === 'image/png') {
        expect(pngSize(await res.body()).join('x'), icon.src).toBe(icon.sizes);
      }
    }
    const apple = await request.get('/apple-icon.png');
    expect(apple.status()).toBe(200);
    expect(pngSize(await apple.body())).toEqual([180, 180]);
  });

  test('sets every screen in IBM Plex Sans, with figures in tabular numerals', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        loaded: [...document.fonts]
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family.replaceAll('"', '')),
        body: getComputedStyle(document.body).fontFamily,
        figures: getComputedStyle(document.body).fontVariantNumeric,
      };
    });
    expect(fonts.loaded).toContain('IBM Plex Sans');
    expect(fonts.body).toMatch(/^"?IBM Plex Sans/);
    expect(fonts.figures).toBe('tabular-nums');
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps every text color at 4.5:1 or more on paper, sheet and wash, ${colorScheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      const token = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const names = ['paper', 'sheet', 'carbon-wash', 'ink', 'ink-2', 'ink-3', 'carbon'];
        const all = [...names, 'carbon-ink', 'ok', 'warn', 'bad'];
        return Object.fromEntries(all.map((n) => [n, css.getPropertyValue(`--${n}`).trim()]));
      });
      const short: string[] = [];
      for (const text of ['ink', 'ink-2', 'ink-3', 'carbon', 'ok', 'warn', 'bad']) {
        for (const ground of ['paper', 'sheet', 'carbon-wash']) {
          const ratio = contrast(token[text]!, token[ground]!);
          if (ratio < 4.5) short.push(`${text} on ${ground}: ${ratio.toFixed(2)}`);
        }
      }
      if (contrast(token['carbon-ink']!, token.carbon!) < 4.5) short.push('carbon-ink on carbon');
      expect(short).toEqual([]);
    });
  }

  test('draws an icon above each tab’s label', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveCount(4);
    for (const label of ['Home', 'Expenses', 'Trips', 'Reports']) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await expect(link.locator('svg')).toHaveCount(1);
    }
    // Capture is a button: it opens every way to bring something in (FR-CAP-12).
    const capture = nav.getByRole('button', { name: 'Capture', exact: true });
    await expect(capture.locator('svg')).toHaveCount(1);
  });
});

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

  test('says plainly when workflows are not configured', async ({ request }) => {
    // E2E runs without Inngest keys; production gets them from the Vercel integration.
    const res = await request.get('/api/inngest');
    expect(res.status()).toBe(503);
    expect(res.headers()['content-type']).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'workflows_not_configured' });
  });

  test('answers unknown API routes with a problem document', async ({ request }) => {
    const res = await request.get('/api/v1/does-not-exist');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/problem+json');
  });
});
