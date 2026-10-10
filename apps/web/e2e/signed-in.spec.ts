import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';
import { showDate } from '@expensewise/domain';
import {
  BENCH_URL,
  benchDay,
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
  (label: string, value: string | (() => string)): Step =>
  (page) =>
    page
      .getByLabel(label, { exact: true })
      .first()
      .fill(typeof value === 'string' ? value : value());

/** The day `offset` days from the bench's day 0, worked out once the bench says which day it is. */
const day = (offset: number) => () => benchDay(seeded.today, offset);
/** Noon on that day, on the browser's clock. */
const noon = (offset: number) => () => `${day(offset)()}T12:00:00`;

/** The API's answer to a request that needs the second factor. */
const needsTheCode = (detail: string) => ({
  status: 403,
  contentType: 'application/problem+json',
  body: JSON.stringify({
    type: 'https://expensewise.app/problems/second-factor-required',
    title: 'This needs your second factor',
    status: 403,
    code: 'second_factor_required',
    detail,
  }),
});

/**
 * The API asks for the second factor before changes at `pattern`, as it does while the second
 * factor is switched on and the session hasn't passed it; reads go through as before.
 */
const asksForTheCode =
  (pattern: string): Step =>
  (page) =>
    page.route(pattern, (route) =>
      route.request().method() === 'GET'
        ? route.fallback()
        : route.fulfill(
            needsTheCode('Enter the code from your authenticator app, then try again.'),
          ),
    );

/**
 * The API asks for the second factor before reads at `pattern` too, as it does for someone with
 * an authenticator whose session hasn't passed it while the second factor is on (#85).
 */
const asksForTheCodeToRead =
  (pattern: string): Step =>
  (page) =>
    page.route(pattern, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(
            needsTheCode(
              'Your organization asks for the code from your authenticator app before anything else. Enter it, then try again.',
            ),
          )
        : route.fallback(),
    );

/**
 * The API holds this email until it adds its own authenticator, at `pattern` for `method`, as
 * it does for a person with one on another email while the second factor is on (#88); with
 * `noneLetIn`, as it holds the email they first signed in with while none of theirs is let in
 * (#91).
 */
const holdsThisEmail =
  (pattern: string, method = 'GET', noneLetIn = false): Step =>
  (page) =>
    page.route(pattern, (route) =>
      route.request().method() === method
        ? route.fulfill({
            status: 403,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'https://expensewise.dev/problems/authenticator-required',
              title: 'This email needs its own authenticator',
              status: 403,
              code: 'authenticator_required',
              detail: `${E2E_USER}@example.com has no authenticator app of its own, and another email you sign in with has one.`,
              email: `${E2E_USER}@example.com`,
              ...(noneLetIn ? { noneLetIn: true } : {}),
            }),
          })
        : route.fallback(),
    );

/**
 * The API refuses this email as not let in, at `pattern` for `method`, as it does once a person
 * has an authenticator and hasn't let this email in, while the second factor is on (#90); with
 * `noneLetIn`, as it refuses any but the email they first signed in with while none of theirs is
 * let in (#91).
 */
const refusesThisEmail =
  (pattern: string, method = 'GET', noneLetIn = false): Step =>
  (page) =>
    page.route(pattern, (route) =>
      route.request().method() === method
        ? route.fulfill({
            status: 403,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'https://expensewise.dev/problems/sign-in-not-let-in',
              title: 'This email isn’t let in to sign in',
              status: 403,
              code: 'sign_in_not_let_in',
              detail: `${E2E_USER}@example.com isn't let in to sign in.`,
              email: `${E2E_USER}@example.com`,
              ...(noneLetIn ? { noneLetIn: true } : {}),
            }),
          })
        : route.fallback(),
    );

/**
 * The person's sign-ins as the API lists them once they let emails in (#90): this one let in,
 * past its code, so it may let the others in; one let in waiting for its own authenticator, and
 * one not let in. Letting one in answers as the API does.
 */
const listsEmailsLetIn: Step = async (page) => {
  // Let in for 24 hours, so it lapses tomorrow (#90).
  const lapsesTomorrow = () => `${day(1)()}T15:00:00Z`;
  const signIn = (id: string, email: string, current: boolean, letIn: string, lapses?: string) => ({
    id: `0192f7a0-0000-7000-8000-0000000000e${id}`,
    email,
    linkedAt: `${day(-8)()}T09:00:00Z`,
    current,
    letIn,
    letInLapsesAt: lapses ?? null,
  });
  await page.route('**/api/v1/me/sign-ins', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            signIns: [
              signIn('1', `${E2E_USER}@example.com`, true, 'yes'),
              signIn('2', 'riley@work.example', false, 'waiting', lapsesTomorrow()),
              signIn('3', 'riley.old@example.net', false, 'no'),
            ],
            canLetIn: true,
          },
        })
      : route.fallback(),
  );
  await page.route('**/api/v1/me/sign-ins/*/let-in', (route) =>
    route.fulfill({
      json: signIn('3', 'riley.old@example.net', false, 'waiting', lapsesTomorrow()),
    }),
  );
};

/** Supabase Auth lists no authenticator app for this email, as for one held until it adds one. */
const noAuthenticatorsOfItsOwn: Step = (page) =>
  page.route(`${E2E_SUPABASE_URL}/auth/v1/user`, (route) =>
    route.fulfill({
      json: {
        id: E2E_USER,
        aud: 'authenticated',
        email: `${E2E_USER}@example.com`,
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-10-01T00:00:00Z',
        factors: [],
      },
    }),
  );

/**
 * Each screen and state: what it shows, where it is, what a person does to get there, where
 * the day decides what shows, the day it is on the person's clock, and the one console error
 * the state means to cause, such as the browser logging a refusal the screen then handles.
 */
const SCREENS: [string, (s: Seeded) => string, Step[], (() => string)?, RegExp?][] = [
  ['Home', () => '/', []],
  ['Home during a trip', () => '/', [], noon(12)],
  ['Home with a trip coming up', () => '/', [], noon(23)],
  [
    'Home with this month’s business miles',
    () => '/',
    [(page) => expect(page.getByText('Business miles', { exact: true })).toBeVisible()],
    // The day of the drive home from Omaha, so its month is this one whatever the day.
    noon(-8),
  ],
  ['Home with everything in Needs you open', () => '/', [press('Show all')]],
  [
    'an expense with no category and type, in Needs you',
    () => '/',
    [
      press('Show all'),
      (page) => expect(page.getByText(/^Needs a category and type/).first()).toBeVisible(),
    ],
  ],
  [
    'emails that filed nothing, unproved and empty, in Needs you',
    () => '/',
    [
      press('Show all'),
      (page) => expect(page.getByText(/changed on its way after your email/)).toBeVisible(),
      (page) => expect(page.getByText(/no receipt attached and no text/)).toBeVisible(),
      (page) => expect(page.getByText(/Send it again from your own mailbox/)).toBeVisible(),
      (page) =>
        expect(
          page.getByRole('link', { name: /^Attach the receipt: Fwd: Your Tuesday evening trip/ }),
        ).toHaveAttribute('href', '/receipts'),
      (page) => expect(page.getByRole('button', { name: /^Dismiss: Receipt$/ })).toBeVisible(),
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
  [
    'deleting a receipt filed by mistake',
    (s) => `/receipts/${s.receipts.notRead}`,
    [
      press('Delete this receipt'),
      (page) => expect(page.getByRole('button', { name: 'Delete it' })).toBeVisible(),
    ],
  ],
  ['Expenses', () => '/expenses', []],
  [
    'expenses on no trip, opened from Home',
    () => `/expenses?from=${day(-8)()}&to=${day(22)()}&onTrip=no`,
    [],
  ],
  [
    'searching expenses',
    () => '/expenses',
    [fill('Merchant', 'uber'), fill('From', day(-38)), fill('To', day(22)), press('Search')],
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
  [
    'a flight with where it went and the day it departs',
    (s) => `/expenses/${s.expenses.flight}`,
    // On the expense, and under its receipt as read.
    [
      (page) =>
        expect(page.getByText(`SFO → OMA, departs ${showDate(day(-10)())}`).first()).toBeVisible(),
    ],
  ],
  ['a hotel stay with its nights', (s) => `/expenses/${s.expenses.stay}`, []],
  ['correcting a journey and a stay', (s) => `/expenses/${s.expenses.stay}`, [press('Edit')]],
  ['a hotel stay whose nights aren’t sure', (s) => `/expenses/${s.expenses.stayUnsure}`, []],
  ['a folio’s stay as each model read it', (s) => `/receipts/${s.receipts.stay}`, []],
  ['a folio whose dates can’t be right', (s) => `/receipts/${s.receipts.stayUnsure}`, []],
  [
    'adding mileage',
    () => '/mileage/new',
    [
      fill('Date', day(-17)),
      fill('Miles', '38.4'),
      fill('Destination', 'IAH airport'),
      fill('Business purpose', 'Drive to the airport for the Acme onsite'),
    ],
  ],
  ['a drive logged as mileage', (s) => `/expenses/${s.expenses.mileage}`, []],
  [
    'the card: charges with no receipt, statements and matches',
    () => '/card',
    [
      (page) =>
        expect(page.getByRole('heading', { name: '1 charge has no receipt' })).toBeVisible(),
      (page) =>
        expect(page.getByText('Its charges come to $801.30, but it prints $901.30.')).toBeVisible(),
      (page) => expect(page.getByText('Personal.')).toBeVisible(),
    ],
  ],
  ['setting a card charge aside', () => '/card', [press('Set it aside')]],
  [
    'matching a card charge to an expense by hand',
    () => '/card',
    [press('Match to an expense'), (page) => expect(page.getByRole('radio').first()).toBeVisible()],
  ],
  [
    'a card charge with no receipt, in Needs you',
    () => '/',
    [
      press('Show all'),
      (page) =>
        expect(page.getByText(/^Charged to your card ending 4417, with no expense/)).toBeVisible(),
    ],
  ],
  [
    'a fare in euros with the dollars its card was charged',
    (s) => `/expenses/${s.expenses.lufthansa}`,
    [
      (page) => expect(page.getByText(/not at your card’s rate/)).toBeVisible(),
      // The company's card paid it, so it is never claimed (FR-INT-25).
      (page) =>
        expect(page.getByText('Paid by the company (on its card ending 4417)')).toBeVisible(),
    ],
  ],
  [
    'a ride paid by two card charges, its fare and its tip',
    (s) => `/expenses/${s.expenses.ride}`,
    [
      (page) => expect(page.getByRole('heading', { name: 'Its card charges' })).toBeVisible(),
      (page) => expect(page.getByText(/^Together \$18\.40, the expense’s total\.$/)).toBeVisible(),
    ],
  ],
  ['changing a drive', (s) => `/expenses/${s.expenses.mileage}`, [press('Change the drive')]],
  [
    'adding a drive by its route',
    () => '/mileage/new',
    [
      press('By route'),
      fill('Date', day(-9)),
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
      fill('From', day(-38)),
      fill('To', day(22)),
      press('Search'),
    ],
  ],
  [
    'making a trip',
    () => '/trips',
    [
      press('New trip'),
      fill('Name', 'Austin · Initech'),
      fill('First day', day(24)),
      fill('Last day', day(26)),
    ],
  ],
  ['a past trip', (s) => `/trips/${s.trips.omaha}`, []],
  [
    'a trip’s cost, claimed and paid by the company',
    (s) => `/trips/${s.trips.omaha}`,
    [
      // The flight by the policy for airfare, and the ride, the stay and the fare in euros because
      // the company's card paid them (FR-INT-25).
      (page) =>
        expect(page.getByRole('definition').filter({ hasText: '€412.80 + $820.20' })).toBeVisible(),
      (page) => expect(page.getByText('Paid by the company', { exact: true })).toBeVisible(),
    ],
  ],
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
  [
    'what the company paid, apart from a report’s claim',
    (s) => `/reports/${s.reports.open}`,
    [
      (page) =>
        expect(
          page.getByRole('heading', { name: 'Paid by the company, not claimed' }),
        ).toBeVisible(),
      (page) => expect(page.getByText('Full cost', { exact: true })).toBeVisible(),
    ],
  ],
  ['a closed report', (s) => `/reports/${s.reports.closed}`, []],
  [
    'submitting a report for approval',
    (s) => `/reports/${s.reports.closed}`,
    [press('Submit for approval')],
  ],
  ['a report waiting for your approval', (s) => `/reports/${s.reports.toApprove}`, []],
  [
    'returning a report with an expense rejected',
    (s) => `/reports/${s.reports.toApprove}`,
    [
      press('Return it'),
      (page) =>
        page
          .getByLabel(/^Reject /)
          .first()
          .check(),
    ],
  ],
  ['a report returned with a rejected expense', (s) => `/reports/${s.reports.returned}`, []],
  [
    'a rejected expense in Needs you',
    () => '/',
    [
      press('Show all'),
      (page) =>
        expect(page.getByText(/^Its report came back with it rejected/).first()).toBeVisible(),
    ],
  ],
  ['a local expense needing a reason', (s) => `/expenses/${s.expenses.fallback}`, []],
  ['a local expense with its reason', (s) => `/expenses/${s.expenses.lunch}`, []],
  ['organization settings', () => '/settings/organization', []],
  [
    'the types the company pays directly, in organization settings',
    () => '/settings/organization',
    [
      (page) =>
        expect(page.getByRole('heading', { name: 'Paid by the company directly' })).toBeVisible(),
      (page) => expect(page.getByRole('checkbox', { name: 'Airfare' })).toBeChecked(),
    ],
  ],
  [
    'an expense the company paid, by its policy',
    (s) => `/expenses/${s.expenses.flight}`,
    [
      (page) =>
        expect(page.getByText('Paid by the company (your organization’s policy)')).toBeVisible(),
      (page) => expect(page.getByRole('button', { name: 'I paid it' })).toBeVisible(),
    ],
  ],
  ['AI provider settings', () => '/settings/ai', []],
  ['sign-in settings', () => '/settings/sign-ins', []],
  [
    'adding an authenticator app',
    () => '/settings/sign-ins',
    [
      (page) => expect(page.getByText('Password manager', { exact: true })).toBeVisible(),
      press('Add an authenticator app'),
      (page) => expect(page.getByRole('img', { name: /^QR code/ })).toBeVisible(),
      (page) => expect(page.getByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeVisible(),
    ],
  ],
  [
    'the code asked for after signing in',
    () => '/sign-in/code',
    [
      (page) => expect(page.getByLabel('Which authenticator app')).toBeVisible(),
      (page) => expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(),
    ],
  ],
  [
    'the code asked for before an admin change',
    () => '/settings/features',
    [
      asksForTheCode('**/api/v1/settings/features/**'),
      (page) => page.getByRole('switch', { name: 'Report export' }).click(),
      (page) =>
        expect(page.getByRole('heading', { name: 'Enter your code to continue' })).toBeVisible(),
      (page) => expect(page.getByRole('heading', { name: 'Features', level: 1 })).toBeHidden(),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'the code asked for before a read',
    () => '/settings/organization',
    [
      asksForTheCodeToRead('**/api/v1/settings/organization'),
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(page.getByRole('heading', { name: 'Enter your code to continue' })).toBeVisible(),
      (page) => expect(page.getByText(/asks for it before anything else/)).toBeVisible(),
      (page) => expect(page.getByLabel('Which authenticator app')).toBeVisible(),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'an email that needs its own authenticator, held before a read',
    () => '/settings/organization',
    [
      holdsThisEmail('**/api/v1/settings/organization'),
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(
          page.getByRole('heading', { name: 'This email needs its own authenticator', level: 1 }),
        ).toBeVisible(),
      (page) =>
        expect(page.getByRole('heading', { name: `${E2E_USER}@example.com` })).toBeVisible(),
      (page) =>
        expect(page.getByRole('link', { name: 'Add one in Settings › Sign-ins' })).toBeVisible(),
      // There is no code to enter yet, so it is never asked for one.
      (page) =>
        expect(page.getByRole('heading', { name: 'Enter your code to continue' })).toHaveCount(0),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'an email that needs its own authenticator, adding one in Settings › Sign-ins',
    () => '/settings/sign-ins',
    [
      holdsThisEmail('**/api/v1/me/organization', 'POST'),
      noAuthenticatorsOfItsOwn,
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(
          page.getByRole('heading', { name: 'This email needs its own authenticator', level: 2 }),
        ).toBeVisible(),
      (page) => expect(page.getByRole('heading', { name: 'Your sign-ins' })).toHaveCount(0),
      press('Add an authenticator app'),
      (page) => expect(page.getByRole('img', { name: /^QR code/ })).toBeVisible(),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'an email that isn’t let in, refused before a read',
    () => '/settings/organization',
    [
      refusesThisEmail('**/api/v1/settings/organization'),
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(
          page.getByRole('heading', { name: 'This email isn’t let in to sign in', level: 1 }),
        ).toBeVisible(),
      (page) =>
        expect(page.getByRole('heading', { name: `${E2E_USER}@example.com` })).toBeVisible(),
      (page) =>
        expect(page.getByText('Receipts you send from this email are still filed.')).toBeVisible(),
      (page) => expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(),
      // Never asked for a code, or offered an authenticator.
      (page) =>
        expect(page.getByRole('heading', { name: 'Enter your code to continue' })).toHaveCount(0),
      (page) => expect(page.getByRole('link', { name: /Settings › Sign-ins/ })).toHaveCount(0),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'an email that isn’t let in while none is, refused before a read',
    () => '/settings/organization',
    [
      refusesThisEmail('**/api/v1/settings/organization', 'GET', true),
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(
          page.getByRole('heading', { name: 'This email isn’t let in to sign in', level: 1 }),
        ).toBeVisible(),
      (page) =>
        expect(
          page.getByText(/only the email you first signed in with is let in on its own/),
        ).toBeVisible(),
      (page) =>
        expect(
          page.getByText(/To let it in, sign in with the email you first signed in with/),
        ).toBeVisible(),
      (page) =>
        expect(page.getByText('Receipts you send from this email are still filed.')).toBeVisible(),
      (page) => expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(),
      (page) =>
        expect(page.getByRole('heading', { name: 'Enter your code to continue' })).toHaveCount(0),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'the email first signed in with, held for its own authenticator while none is let in',
    () => '/settings/organization',
    [
      holdsThisEmail('**/api/v1/settings/organization', 'GET', true),
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(
          page.getByRole('heading', { name: 'This email needs its own authenticator', level: 1 }),
        ).toBeVisible(),
      (page) =>
        expect(
          page.getByText(/This is the email you first signed in with, the one let in first/),
        ).toBeVisible(),
      (page) =>
        expect(page.getByRole('link', { name: 'Add one in Settings › Sign-ins' })).toBeVisible(),
      // It never sends them to the email with the authenticator, which waits to be let in.
      (page) => expect(page.getByText(/sign in with the email that has yours/)).toHaveCount(0),
    ],
    undefined,
    /status of 403/,
  ],
  [
    'letting another email in, in Settings › Sign-ins',
    () => '/settings/sign-ins',
    [
      listsEmailsLetIn,
      (page) => page.reload({ waitUntil: 'networkidle' }),
      (page) =>
        expect(page.getByText(/^Let in until .+, to add its own authenticator app$/)).toBeVisible(),
      (page) =>
        expect(page.getByText('Not let in: receipts sent from it are still filed')).toBeVisible(),
      (page) =>
        expect(page.getByRole('button', { name: 'Withdraw riley@work.example' })).toBeVisible(),
      (page) => page.getByRole('button', { name: 'Let in riley.old@example.net' }).click(),
      (page) =>
        expect(page.getByText(/^riley\.old@example\.net is let in for 24 hours/)).toBeVisible(),
    ],
  ],
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
    [fill('From', day(53)), fill('Rate a mile (USD)', '0.62')],
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
    'a folio’s credit and each night’s charges, read as printed',
    (s) => `/expenses/${s.expenses.folioCredit}`,
    [press('Show the receipt’s lines')],
  ],
  [
    'a flight receipt of two purchases, the ticket and a seat upgrade bought later',
    (s) => `/expenses/${s.expenses.seatUpgrade}`,
    [
      press('Show the receipt’s lines'),
      (page) =>
        expect(page.getByText(`Bought ${showDate(day(-27)())}, card ending 4417`)).toBeVisible(),
    ],
  ],
  [
    'leaving a seat upgrade out of the claim, with its own taxes',
    (s) => `/expenses/${s.expenses.seatUpgrade}`,
    [
      press('Leave out Seat upgrade'),
      (page) =>
        expect(
          page.getByText('Why leave Seat upgrade out? It takes $84.93 off the claim.'),
        ).toBeVisible(),
    ],
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
  [
    'people settings, with who approves each person’s reports, one chosen who can’t approve now',
    () => '/settings/people',
    [
      (page) =>
        expect(page.getByText(/^sam can’t approve now, so your reports go to casey/)).toBeVisible(),
      (page) => expect(page.getByLabel('Who approves sam’s reports')).toHaveValue(/.+/),
    ],
  ],
  ['an invite link this account can’t use', (s) => `/invite/${s.invites.join}`, []],
  ['a revoked invite link', (s) => `/invite/${s.invites.revoked}`, []],
];

/** The bench user's two authenticator apps (F-11), as Supabase Auth lists them. */
const factors = (
  [
    ['0192f7a0-0000-7000-8000-00000000f001', 'iPhone', '2026-10-05T09:00:00Z'],
    ['0192f7a0-0000-7000-8000-00000000f002', 'Password manager', '2026-10-05T09:05:00Z'],
  ] as const
).map(([id, name, at]) => ({
  id,
  friendly_name: name,
  factor_type: 'totp',
  status: 'verified',
  created_at: at,
  updated_at: at,
}));

/** What Supabase Auth answers to adding one: a QR code to scan and the key to type. */
const enrollment = {
  id: '0192f7a0-0000-7000-8000-00000000f003',
  type: 'totp',
  friendly_name: 'Authenticator 3',
  totp: {
    qr_code:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="168" height="168">' +
      '<rect width="21" height="21" fill="white"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z"/>' +
      '</svg>',
    secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    uri: 'otpauth://totp/ExpenseWise:riley@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ExpenseWise',
  },
};

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
  // Registered later, so they answer first: the user with their authenticator apps, and
  // adding one (F-11).
  await context.route(`${E2E_SUPABASE_URL}/auth/v1/user`, (route) =>
    route.fulfill({ json: { ...session.user, factors } }),
  );
  await context.route(`${E2E_SUPABASE_URL}/auth/v1/factors`, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ json: enrollment }) : route.fallback(),
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

for (const [title, path, steps, at, expected] of SCREENS) {
  test(`${title}: fits the screen and passes WCAG 2.2 AA, in light and dark`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !expected?.test(message.text())) {
        errors.push(message.text());
      }
    });
    const settled = requestsInFlight(page);
    const size = page.viewportSize()!;
    if (at) await page.clock.setFixedTime(new Date(at()));

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
