import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  BENCH_URL,
  E2E_SESSION_KEY,
  E2E_SUPABASE_URL,
  E2E_USER,
  type Seeded,
} from './bench/config';
import { layoutProblems } from './layout';

/*
 * Every signed-in screen, in each state it can be in, checked as a person would see it (#54):
 * at the project's own size, and on the iPhone also at the narrowest and widest phones; in
 * light and dark; for layout (e2e/layout.ts) and WCAG 2.2 AA. The data is real, from the
 * bench API (e2e/bench/server.ts), which the Playwright config starts.
 */

const OTHER_PHONE_WIDTHS = [375, 440];
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Step = (page: Page) => Promise<unknown>;
const press =
  (name: string): Step =>
  (page) =>
    page.getByRole('button', { name }).first().click();
const fill =
  (label: string, value: string): Step =>
  (page) =>
    page.getByLabel(label, { exact: true }).first().fill(value);

/**
 * Each screen and state: what it shows, where it is, what a person does to get there, and,
 * where the day decides what shows, the day it is on the person's clock.
 */
const SCREENS: [string, (s: Seeded) => string, Step[], string?][] = [
  ['Home', () => '/', []],
  ['Home during a trip', () => '/', [], '2026-10-21T12:00:00'],
  ['Home with a trip coming up', () => '/', [], '2026-11-01T12:00:00'],
  ['Home with everything in Needs you open', () => '/', [press('Show all')]],
  [
    'an expense with no category and type, in Needs you',
    () => '/',
    [
      press('Show all'),
      (page) => expect(page.getByText(/^Needs a category and type/).first()).toBeVisible(),
    ],
  ],
  ['Receipts', () => '/receipts', []],
  ['a Ready receipt', (s) => `/receipts/${s.receipts.coffee}`, []],
  [
    'correcting a field of a Ready receipt',
    (s) => `/receipts/${s.receipts.coffee}`,
    [press('Correct the total')],
  ],
  ['a Ready receipt corrected with a tap', (s) => `/receipts/${s.receipts.parking}`, []],
  ['a receipt the models read differently', (s) => `/receipts/${s.receipts.folio}`, []],
  ['correcting a reading', (s) => `/receipts/${s.receipts.folio}`, [press('Edit a field')]],
  ['a reading confirmed with corrections', (s) => `/receipts/${s.receipts.steak}`, []],
  ['a receipt only the fallback read', (s) => `/receipts/${s.receipts.fallback}`, []],
  ['a receipt nothing could read', (s) => `/receipts/${s.receipts.failed}`, []],
  ['a receipt whose parts don’t make its total', (s) => `/receipts/${s.receipts.sums}`, []],
  ['a receipt dated after it was uploaded', (s) => `/receipts/${s.receipts.future}`, []],
  ['a ride receipt with fees, and a later copy of it', (s) => `/receipts/${s.receipts.uber}`, []],
  ['a purchase summary', (s) => `/receipts/${s.receipts.summary}`, []],
  ['an exact copy of a receipt', (s) => `/receipts/${s.receipts.uberAgain}`, []],
  [
    'deleting one of an exact pair',
    (s) => `/receipts/${s.receipts.uberAgain}`,
    [press('Other choices'), press('Delete one')],
  ],
  ['a possible duplicate with a tip added', (s) => `/receipts/${s.receipts.dinnerSlip}`, []],
  ['merging a possible duplicate', (s) => `/receipts/${s.receipts.dinnerSlip}`, [press('Merge')]],
  ['the earlier of a possible pair', (s) => `/receipts/${s.receipts.dinner}`, []],
  ['a receipt being read', (s) => `/receipts/${s.receipts.processing}`, []],
  ['a receipt the primary model read', (s) => `/receipts/${s.receipts.primaryRead}`, []],
  ['a receipt a back-up model read', (s) => `/receipts/${s.receipts.backupRead}`, []],
  ['a receipt filed with every AI model off', (s) => `/receipts/${s.receipts.notRead}`, []],
  ['Expenses', () => '/expenses', []],
  [
    'expenses on no trip, opened from Home',
    () => '/expenses?from=2026-10-01&to=2026-10-31&onTrip=no',
    [],
  ],
  [
    'searching expenses',
    () => '/expenses',
    [
      fill('Merchant', 'uber'),
      fill('From', '2026-09-01'),
      fill('To', '2026-10-31'),
      press('Search'),
    ],
  ],
  ['an expense that differs from its receipt', (s) => `/expenses/${s.expenses.coffee}`, []],
  ['editing an expense', (s) => `/expenses/${s.expenses.coffee}`, [press('Edit')]],
  [
    'choosing a trip for an expense',
    (s) => `/expenses/${s.expenses.coffee}`,
    [press('Change trip')],
  ],
  ['an expense put on a trip by hand', (s) => `/expenses/${s.expenses.lufthansa}`, []],
  ['an expense with when and where it was bought', (s) => `/expenses/${s.expenses.uber}`, []],
  ['editing when and where it was bought', (s) => `/expenses/${s.expenses.uber}`, [press('Edit')]],
  ['an expense still being read', (s) => `/expenses/${s.expenses.processing}`, []],
  ['a ride with where it went', (s) => `/expenses/${s.expenses.ride}`, []],
  ['a flight with where it went', (s) => `/expenses/${s.expenses.flight}`, []],
  ['a hotel stay with its nights', (s) => `/expenses/${s.expenses.stay}`, []],
  ['correcting a journey and a stay', (s) => `/expenses/${s.expenses.stay}`, [press('Edit')]],
  ['a hotel stay whose nights aren’t sure', (s) => `/expenses/${s.expenses.stayUnsure}`, []],
  ['a folio’s stay as each model read it', (s) => `/receipts/${s.receipts.stay}`, []],
  ['a folio whose dates can’t be right', (s) => `/receipts/${s.receipts.stayUnsure}`, []],
  [
    'adding mileage',
    () => '/mileage/new',
    [
      fill('Date', '2026-09-22'),
      fill('Miles', '38.4'),
      fill('Destination', 'IAH airport'),
      fill('Business purpose', 'Drive to the airport for the Acme onsite'),
    ],
  ],
  ['a drive logged as mileage', (s) => `/expenses/${s.expenses.mileage}`, []],
  ['changing a drive', (s) => `/expenses/${s.expenses.mileage}`, [press('Change the drive')]],
  [
    'adding a drive by its route',
    () => '/mileage/new',
    [
      press('By route'),
      fill('Date', '2026-09-30'),
      fill('Business purpose', 'Client visit at Acme'),
      fill('Start', '1520 Harney St, Omaha, NE'),
      press('Add a stop'),
      fill('Stop 2', 'Acme HQ, 1200 Dodge St, Omaha, NE'),
      fill('End', 'Eppley Airfield, Omaha, NE'),
    ],
  ],
  ['a drive measured by its route', (s) => `/expenses/${s.expenses.routeMeasured}`, []],
  [
    'changing the miles of a measured drive',
    (s) => `/expenses/${s.expenses.routeMeasured}`,
    [press('Change the miles'), fill('Miles', '41')],
  ],
  [
    'changing the stops of a measured drive',
    (s) => `/expenses/${s.expenses.routeMeasured}`,
    [press('Change the drive')],
  ],
  ['a drive by its route needing a look', (s) => `/expenses/${s.expenses.routeNotFound}`, []],
  ['Trips', () => '/trips', []],
  [
    'searching trips',
    () => '/trips',
    [
      fill('Name, purpose, city or merchant', 'Omaha'),
      fill('From', '2026-09-01'),
      fill('To', '2026-10-31'),
      press('Search'),
    ],
  ],
  [
    'making a trip',
    () => '/trips',
    [
      press('New trip'),
      fill('Name', 'Austin · Initech'),
      fill('First day', '2026-11-02'),
      fill('Last day', '2026-11-04'),
    ],
  ],
  ['a past trip', (s) => `/trips/${s.trips.omaha}`, []],
  ['a trip with a long name', (s) => `/trips/${s.trips.long}`, []],
  ['a trip with no expenses', (s) => `/trips/${s.trips.empty}`, []],
  ['editing a trip', (s) => `/trips/${s.trips.omaha}`, [press('Edit')]],
  ['deleting a trip', (s) => `/trips/${s.trips.omaha}`, [press('Delete')]],
  ['Reports', () => '/reports', []],
  ['a report still needing review', (s) => `/reports/${s.reports.open}`, []],
  [
    'moving a trip to another report',
    (s) => `/reports/${s.reports.open}`,
    [press('Move to another report')],
  ],
  ['a closed report', (s) => `/reports/${s.reports.closed}`, []],
  ['a local expense needing a reason', (s) => `/expenses/${s.expenses.fallback}`, []],
  ['a local expense with its reason', (s) => `/expenses/${s.expenses.lunch}`, []],
  ['organization settings', () => '/settings/organization', []],
  ['AI provider settings', () => '/settings/ai', []],
  ['sign-in settings', () => '/settings/sign-ins', []],
  ['feature settings', () => '/settings/features', []],
  ['the audit trail, with its chain checked', () => '/settings/audit', []],
  ['the audit trail, older changes shown', () => '/settings/audit', [press('Show older changes')]],
  [
    'one receipt’s history, opened from the receipt',
    (s) => `/settings/audit?entityType=receipt&entityId=${s.receipts.coffee}`,
    [],
  ],
  ['category settings', () => '/settings/categories', []],
  ['editing a category', () => '/settings/categories', [press('Edit Travel')]],
  ['adding a type', () => '/settings/categories', [press('Add a type')]],
  ['an expense with a suggested category', (s) => `/expenses/${s.expenses.lufthansa}`, []],
  [
    'choosing a category and type',
    (s) => `/expenses/${s.expenses.coffee}`,
    [press('Choose another')],
  ],
  ['an expense with its category chosen', (s) => `/expenses/${s.expenses.folio}`, []],
  ['an expense with no category', (s) => `/expenses/${s.expenses.dinner}`, []],
  ['mileage settings, with the rate a mile and its changes', () => '/settings/mileage', []],
  [
    'setting your own rate a mile',
    () => '/settings/mileage',
    [fill('From', '2026-12-01'), fill('Rate a mile (USD)', '0.62')],
  ],
  [
    'going back to the IRS rate a mile',
    () => '/settings/mileage',
    [(page) => page.getByLabel('The IRS business rate').check()],
  ],
  [
    'a hotel folio’s lines, one left out and one split to Meals',
    (s) => `/expenses/${s.expenses.folioLines}`,
    [press('Show the receipt’s lines')],
  ],
  [
    'leaving a line out of the claim',
    (s) => `/expenses/${s.expenses.folioLines}`,
    [press('Show the receipt’s lines'), press('Exclude Valet parking')],
  ],
  [
    'splitting an expense by line',
    (s) => `/expenses/${s.expenses.folioLines}`,
    [press('Split by line')],
  ],
  [
    'a receipt whose lines don’t add up',
    (s) => `/expenses/${s.expenses.linesShort}`,
    [press('Show the receipt’s lines')],
  ],
  [
    'splitting an expense by amount',
    (s) => `/expenses/${s.expenses.linesShort}`,
    [press('Split by amount')],
  ],
  ['AI model settings', () => '/settings/ai-models', []],
  ['reimbursement currency settings', () => '/settings/currency', []],
  ['mileage settings, with the route key and saved places', () => '/settings/mileage', []],
  ['people settings, with a member and a link not used yet', () => '/settings/people', []],
  ['removing someone', () => '/settings/people', [press('Remove sam')]],
  ['an invite link this account can’t use', (s) => `/invite/${s.invites.join}`, []],
  ['a revoked invite link', (s) => `/invite/${s.invites.revoked}`, []],
];

const session = {
  access_token: E2E_USER,
  refresh_token: E2E_USER,
  token_type: 'bearer',
  expires_in: 86_400,
  // Far off, so a screen seen on a later day of the clock still holds a live session.
  expires_at: Math.floor(Date.now() / 1000) + 10 * 365 * 86_400,
  user: {
    id: E2E_USER,
    aud: 'authenticated',
    email: `${E2E_USER}@example.com`,
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-01T00:00:00Z',
  },
};

let seeded: Seeded;
test.beforeAll(async ({ request }) => {
  seeded = (await (await request.get(`${BENCH_URL}/__bench/seeded`)).json()) as Seeded;
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [E2E_SESSION_KEY, JSON.stringify(session)],
  );
  // The app's API calls go to the bench; the stand-in Supabase project answers nothing.
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${BENCH_URL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await context.route(`${E2E_SUPABASE_URL}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
});

/**
 * Counts the page's requests in flight. `settled()` waits until there have been none for a
 * moment. Next.js loads linked screens in the background as their links scroll into view;
 * navigating while one is loading cancels it, and WebKit logs a cancelled request as a console
 * error. Waiting first means every error the test sees is a real one.
 */
function requestsInFlight(page: Page) {
  const pending = new Set<Request>();
  page.on('request', (r) => pending.add(r));
  page.on('requestfinished', (r) => pending.delete(r));
  page.on('requestfailed', (r) => pending.delete(r));
  return async function settled(): Promise<void> {
    const quietFor = 300;
    const deadline = Date.now() + 15_000;
    let quietSince: number | null = null;
    while (Date.now() < deadline) {
      if (pending.size > 0) quietSince = null;
      else if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietFor) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Requests still loading: ${[...pending].map((r) => r.url()).join(', ')}`);
  };
}

async function open(
  page: Page,
  path: string,
  steps: Step[],
  settled: () => Promise<void>,
): Promise<void> {
  await settled();
  await page.goto(path, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in' }),
    'Signed in, no screen asks to sign in. If one does, the app was built without the end-to-end Supabase project: see CLAUDE.md.',
  ).toHaveCount(0);
  for (const step of steps) {
    await step(page);
    await page.waitForLoadState('networkidle');
  }
}

/**
 * Text that shows a date as 2026-09-30 rather than Sep 30, 2026 (Q12, NFR-UX-06). Form fields
 * keep the phone's own date picker, and a model's reading keeps each date as it was read.
 */
function rawDates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('input, textarea, select, script, style, [data-as-read]')) {
        continue;
      }
      const match = /\b\d{4}-\d{2}-\d{2}\b/.exec(node.textContent ?? '');
      if (match && parent.checkVisibility()) found.push(node.textContent!.trim().slice(0, 80));
    }
    return found;
  });
}

for (const [title, path, steps, at] of SCREENS) {
  test(`${title}: fits the screen and passes WCAG 2.2 AA, in light and dark`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const settled = requestsInFlight(page);
    const size = page.viewportSize()!;
    if (at) await page.clock.setFixedTime(new Date(at));

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await open(page, path(seeded), steps, settled);
      const where = `${colorScheme}, ${size.width}px`;
      expect(await layoutProblems(page), where).toEqual([]);
      if (colorScheme === 'light')
        expect(await rawDates(page), 'dates read Sep 30, 2026').toEqual([]);
      // The tab bar covers whatever is scrolled under it until the person scrolls on; that
      // is not a target too small to tap. Axe sees the page with the bar in its place at the
      // end instead, and focus never stops behind it (scroll-padding in globals.css).
      await page.addStyleTag({
        content: 'div:has(> nav[aria-label="Main"]) { position: static !important; }',
      });
      const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(
        axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        where,
      ).toEqual([]);
    }

    if (testInfo.project.name === 'iphone-webkit') {
      await page.emulateMedia({ colorScheme: 'light' });
      for (const width of OTHER_PHONE_WIDTHS) {
        await settled();
        await page.setViewportSize({ width, height: size.height });
        await open(page, path(seeded), steps, settled);
        expect(await layoutProblems(page), `light, ${width}px`).toEqual([]);
      }
    }
    await settled();
    expect(errors, 'errors in the console').toEqual([]);
  });
}

test('a receipt opens its history in the audit trail, under the chain checked intact', async ({
  page,
}) => {
  await page.goto(`/receipts/${seeded.receipts.coffee}`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'History of this receipt' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();
  await expect(page.getByText(/^Chain intact: [\d,]+ events checked$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /^History of receipt / })).toBeVisible();
  await expect(page.getByText('Receipt captured', { exact: true })).toHaveCount(1);
});

test('hides a record’s History link while the audit trail is off', async ({ page }) => {
  // As if the owner had switched it off: the features list says so.
  await page.route(
    (url) => url.pathname === '/api/v1/features',
    (route) => route.fulfill({ json: { features: [], canSwitch: true } }),
  );
  await page.goto(`/expenses/${seeded.expenses.coffee}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^History/ })).toHaveCount(0);
});

test('hides a record’s History link from a role that can’t read the trail', async ({ page }) => {
  // As a member or approver: the trail answers 403 forbidden_role.
  await page.route(
    (url) => url.pathname === '/api/v1/audit/events',
    (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Forbidden', status: 403, code: 'forbidden_role' }),
      }),
  );
  await page.goto(`/reports/${seeded.reports.open}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^History/ })).toHaveCount(0);
});

test('the audit trail holds no key or token in any event’s details', async ({ request }) => {
  // The bench saved this Anthropic key through the API; only its last four characters may show.
  const KEY = 'sk-ant-bench-0000-wxyz';
  const SECRET_FIELD = /"(api_?key|secret|password|token|access_?token|ciphertext)":/i;
  const headers = { authorization: `Bearer ${E2E_USER}` };
  let cursor: string | null = null;
  let seen = 0;
  do {
    const res = await request.get(
      `${BENCH_URL}/api/v1/audit/events?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
      { headers },
    );
    expect(res.status()).toBe(200);
    const page = (await res.json()) as {
      events: { sequence: number; payload: unknown }[];
      nextCursor: string | null;
    };
    for (const event of page.events) {
      const details = JSON.stringify(event.payload);
      expect(details, `event #${event.sequence}`).not.toContain(KEY.slice(0, 12));
      expect(details, `event #${event.sequence}`).not.toMatch(SECRET_FIELD);
    }
    seen += page.events.length;
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toBeGreaterThan(50);
});
