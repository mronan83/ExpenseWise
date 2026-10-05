/**
 * The bench API for the signed-in end-to-end checks (#54). The real API (`createHttpApp`) on a
 * database of its own, seeded through the API itself and the real reading workflow with
 * scripted model answers, so every screen can be opened in each state it can be in:
 *
 *   DATABASE_URL=postgres://… pnpm exec tsx e2e/bench/server.ts
 *
 * DATABASE_URL is a Postgres superuser connection, as for the integration tests. The bench
 * signs a request in as whoever its bearer token names and calls no AI provider. Receipt
 * images are drawn here, never taken from real receipts. Playwright starts it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import {
  createHttpApp,
  dbApprovalStore,
  createSecretBox,
  dbAuditStore,
  dbCategoryStore,
  dbExpenseStore,
  dbReceiptStore,
  dbHomeStore,
  dbItemizedStore,
  dbOrganizationStore,
  dbMileageRateStore,
  dbMileageStore,
  dbModelSettingsStore,
  dbReimbursementStore,
  dbPeopleStore,
  dbReportStore,
  dbRouteKeyStore,
  dbRouteMileageStore,
  dbTripStore,
  dbUnfiledEmailStore,
  dbWorkspaceStore,
  ORG_FEATURE_KEYS,
} from '@expensewise/api';
import {
  createDatabase,
  findMemberships,
  recordInboundEmail,
  ROUTE_MEASURE_REQUESTED,
  runReportSchedule,
  setRolePasswords,
  withOrg,
} from '@expensewise/db';
import { derivedId } from '@expensewise/domain';
import { runMigrations } from '@expensewise/db/migrate';
import { COMPARISON_MODELS, FALLBACK_MODEL, type ModelId } from '@expensewise/extraction';
import {
  conversionPorts,
  convertOrganization,
  measureRoute,
  readWith,
  receiptReadingPorts,
  routeMeasuringPorts,
  settleReading,
} from '@expensewise/workflows';
import { BENCH_PORT, E2E_USER, type Seeded } from './config';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('The bench needs DATABASE_URL, a Postgres superuser connection (pnpm db:up).');
  process.exit(1);
}
const withDatabase = (url: string, database: string, user?: string, password?: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user && password) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
};

// One bench database at a time: earlier runs' are dropped first.
const database = `e2e_bench_${randomBytes(4).toString('hex')}`;
const admin = createDatabase(baseUrl);
const stale = await admin.pool.query<{ datname: string }>(
  `select datname from pg_database where datname like 'e2e_bench_%'`,
);
for (const { datname } of stale.rows) {
  await admin.pool.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
}
await admin.pool.query(`CREATE DATABASE ${database}`);
await admin.pool.end();

const ownerUrl = withDatabase(baseUrl, database);
await runMigrations(ownerUrl);
// The integration tests' passwords: roles are shared by every database on the server.
const APP_PASSWORD = 'expensewise-app-test-password';
const owner = createDatabase(ownerUrl);
const client = await owner.pool.connect();
try {
  await setRolePasswords(client, {
    expensewise_app: APP_PASSWORD,
    expensewise_relay: 'expensewise-relay-test-password',
  });
} finally {
  client.release();
  await owner.pool.end();
}
const { db } = createDatabase(withDatabase(baseUrl, database, 'expensewise_app', APP_PASSWORD));

/** A grey receipt-shaped PNG with dark rows for lines of text, distinct per seed. */
function receiptImage(seed: string, width = 320, height = 640): Uint8Array {
  const row = (y: number) => {
    const line = y > 40 && y % 28 < 9 && y < height - 60;
    const ink = line && (y * 7 + seed.length * 13) % 5 !== 0;
    return Buffer.concat([
      Buffer.from([0]),
      Buffer.alloc(width, ink ? 70 : 248)
        .fill(248, 0, 24)
        .fill(248, width - 24),
    ]);
  };
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => row(y)));
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
      // After the image ends: makes each seeded receipt's file, and its hash, its own.
      Buffer.from(seed),
    ]),
  );
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const files = new Map<string, Uint8Array>();
const store = {
  signedUpload: (path: string) => Promise.resolve({ path, token: 'bench' }),
  signedDownloadUrl: (path: string) =>
    Promise.resolve(`http://127.0.0.1:${BENCH_PORT}/files/${encodeURIComponent(path)}`),
  download: (path: string) => Promise.resolve(files.get(path) ?? null),
  save: (path: string, bytes: Uint8Array) => {
    files.set(path, bytes);
    return Promise.resolve();
  },
  remove: (path: string) => {
    files.delete(path);
    return Promise.resolve();
  },
};

/** What each model answers for a receipt: a reading, or nothing usable. */
type Script = Partial<Record<string, Record<string, unknown> | 'refuse'>>;
const scripts = new Map<string, Script>();
/**
 * Receipts read under the organization's AI model settings (FR-INT-16), in this order: the
 * primary, then each back-up only while the ones before it read nothing. Empty: every model off.
 */
const orders = new Map<string, ModelId[]>();

const reading = (
  merchant: string,
  date: string,
  currency: string,
  total: string,
  more: Record<string, unknown> = {},
) => ({
  documentType: 'receipt',
  merchant: { name: merchant, confidence: 'high' },
  date: { value: date, confidence: 'high' },
  currency: { code: currency, confidence: 'high' },
  total: { value: total, confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
  ...more,
});
const both = (r: Record<string, unknown>): Script => ({
  [COMPARISON_MODELS[0]]: r,
  [COMPARISON_MODELS[1]]: r,
});

/**
 * OpenRouteService as the bench answers it (ADR-0039): the addresses it knows, and each leg's
 * distance by the stops it joins. The bench never calls the real service.
 */
const ROUTE_PLACES: Record<string, [number, number, string]> = {
  '1520 Harney St, Omaha, NE': [-95.936117, 41.257163, '1520 Harney Street, Omaha, NE, USA'],
  'Acme HQ, 1200 Dodge St, Omaha, NE': [-95.932468, 41.261511, '1200 Dodge Street, Omaha, NE, USA'],
  'Eppley Airfield, Omaha, NE': [-95.894069, 41.303166, 'Eppley Airfield, Omaha, NE, USA'],
};
const ROUTE_LEGS = [9400.4, 52399.5, 60000];
const openRouteServiceFake = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const json = (body: unknown) => Promise.resolve(Response.json(body, { status: 200 }));
  if (url.pathname === '/geocode/search') {
    const found = ROUTE_PLACES[url.searchParams.get('text') ?? ''];
    return json({
      type: 'FeatureCollection',
      features: found
        ? [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [found[0], found[1]] },
              properties: { label: found[2] },
            },
          ]
        : [],
    });
  }
  const { coordinates = [] } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    coordinates?: unknown[];
  };
  return json({
    routes: [
      { segments: coordinates.slice(1).map((_, i) => ({ distance: ROUTE_LEGS[i] ?? 5000 })) },
    ],
  });
};
const measuring = routeMeasuringPorts({
  db,
  routeKey: () => Promise.resolve({ key: 'ors-bench-key-0000-wxyz' }),
  service: { fetch: openRouteServiceFake },
});

/** The real reading and route-measuring workflows, with each answer scripted. */
async function dispatch(
  events: readonly { orgId: string; outboxId: string; topic?: string; payload: unknown }[],
): Promise<void> {
  for (const event of events) {
    if (event.topic === ROUTE_MEASURE_REQUESTED) {
      const { expenseId } = event.payload as { expenseId: string };
      const request = { orgId: event.orgId, expenseId, requestId: event.outboxId };
      const outcome = await measureRoute(measuring, request);
      if (outcome !== 'stale') await measuring.settle(request, outcome);
      continue;
    }
    const { receiptId } = event.payload as { receiptId: string };
    const script = scripts.get(receiptId);
    if (!script) continue; // left reading
    const ports = {
      ...receiptReadingPorts({ db, files: store, providerKey: () => Promise.resolve('no_key') }),
      extractor: (_orgId: string, model: string) =>
        Promise.resolve({
          model,
          extract: () => {
            const answer = script[model];
            const usable = answer && answer !== 'refuse';
            return Promise.resolve({
              outcome: usable ? 'extracted' : 'refused',
              extraction: usable ? answer : null,
              model,
              promptVersion: 'bench',
              latencyMs: model === COMPARISON_MODELS[0] ? 2100 : 5400,
              usage: {
                inputTokens: 1800,
                outputTokens: 320,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              costNanoUsd: 2_600_000n,
            });
          },
        }),
    } as unknown as Parameters<typeof readWith>[0];
    const request = { orgId: event.orgId, receiptId, requestId: event.outboxId };
    const order = orders.get(receiptId);
    if (order) {
      for (const [i, model] of order.entries()) {
        const role = i === 0 ? 'primary' : 'backup';
        const outcome = await readWith(ports, request, model, 'image/png', { role });
        if (outcome === 'confident' || outcome === 'unsure') break;
      }
      await settleReading(ports, request, undefined, { mode: 'primary', order });
      continue;
    }
    const outcomes = [];
    for (const model of COMPARISON_MODELS) {
      outcomes.push(await readWith(ports, request, model, 'image/png'));
    }
    if (outcomes.every((o) => o === 'failed') && script[FALLBACK_MODEL]) {
      await readWith(ports, request, FALLBACK_MODEL, 'image/png');
    }
    await settleReading(ports, request);
  }
}

const app = createHttpApp({
  version: 'bench',
  verifyToken: (token) =>
    Promise.resolve({
      userId: token,
      email: `${token}@example.com`,
      // Past the second factor, as the owner who switched it on must be (F-11): every feature
      // is switched on below, the second factor too, and admin changes then need it.
      assuranceLevel: 'aal2',
      sessionId: 'bench',
      issuedAt: new Date(),
    }),
  workspace: dbWorkspaceStore(db),
  organization: dbOrganizationStore(db),
  receipts: dbReceiptStore(db),
  expenses: dbExpenseStore(db),
  trips: dbTripStore(db),
  mileage: dbMileageStore(db),
  mileageRates: dbMileageRateStore(db),
  routeMileage: dbRouteMileageStore(db),
  routeKeys: dbRouteKeyStore(db),
  home: dbHomeStore(db),
  people: dbPeopleStore(db),
  reports: dbReportStore(db),
  approvals: dbApprovalStore(db),
  audit: dbAuditStore(db),
  categories: dbCategoryStore(db),
  itemized: dbItemizedStore(db),
  modelSettings: dbModelSettingsStore(db),
  reimbursement: dbReimbursementStore(db),
  emails: dbUnfiledEmailStore(db),
  files: store,
  dispatch,
  secrets: createSecretBox('bench-only-secret-0123456789'),
  verifyProviderKey: () => Promise.resolve({ ok: true, authScheme: 'api_key' }),
  verifyRouteKey: () => Promise.resolve({ ok: true }),
});

/** Calls the API as `user`, whom the bench signs in by name. */
async function callAs<T>(user: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${user}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const call = <T>(method: string, path: string, body?: unknown) =>
  callAs<T>(E2E_USER, method, path, body);

// The organization, a key, trips, receipts in every state, and expenses changed by hand.
const { organization } = await call<{ organization: { id: string } }>(
  'POST',
  '/v1/me/organization',
);
await call('PUT', '/v1/settings/ai-providers/anthropic', { apiKey: 'sk-ant-bench-0000-wxyz' });
// Every feature is switched on, as the owner would after checking it (ADR-0032), so each
// flagged screen is checked here too.
for (const key of ORG_FEATURE_KEYS) {
  await call('PUT', `/v1/settings/features/${key}`, { enabled: true });
}

// People (#29): Sam joined by a link, and a link for Jordan not used yet. Another
// organization's owner sent Riley a link, which Riley's own work stops Riley joining, and
// revoked a second one.
type Made = { token: string; invite: { id: string } };
const sam = await call<Made>('POST', '/v1/settings/people/invites', {
  role: 'member',
  label: 'Sam',
});
await callAs('sam', 'POST', '/v1/invites/accept', { token: sam.token });
await call('POST', '/v1/settings/people/invites', { role: 'approver', label: 'Jordan' });
await callAs('morgan', 'POST', '/v1/me/organization');
await callAs('morgan', 'PUT', '/v1/settings/features/team.invites', { enabled: true });
const join = await callAs<Made>('morgan', 'POST', '/v1/settings/people/invites', {
  role: 'finance_admin',
});
const revoked = await callAs<Made>('morgan', 'POST', '/v1/settings/people/invites', {
  role: 'member',
});
await callAs('morgan', 'DELETE', `/v1/settings/people/invites/${revoked.invite.id}`);

const trip = (body: Record<string, string>) => call<{ id: string }>('POST', '/v1/trips', body);
const trips = {
  omaha: await trip({
    name: 'Q4 Architect Meeting',
    purpose: 'Quarterly architecture review',
    primaryCity: 'Omaha, NE',
    startDate: '2026-09-29',
    endDate: '2026-10-01',
  }),
  houston: await trip({
    name: 'Houston · Acme onsite',
    purpose: 'Client onsite',
    primaryCity: 'Houston',
    startDate: '2026-09-22',
    endDate: '2026-09-25',
  }),
  long: await trip({
    name: 'Northern California customer advisory board and partner summit week',
    purpose:
      'Customer advisory board, partner summit and two days of executive briefings with the regional leadership team',
    primaryCity: 'Half Moon Bay, California',
    startDate: '2026-10-20',
    endDate: '2026-10-23',
  }),
  empty: await trip({ name: 'Frankfurt', startDate: '2026-11-09', endDate: '2026-11-12' }),
  // Everything on it Ready: it is moved to a report of its own, and closed.
  chicago: await trip({
    name: 'Chicago · partner review',
    primaryCity: 'Chicago',
    startDate: '2026-09-01',
    endDate: '2026-09-03',
  }),
};

const receipts: Record<string, string> = {};
async function capture(
  name: string,
  source: 'camera' | 'upload',
  script?: Script,
  order?: ModelId[],
) {
  const bytes = receiptImage(name);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const described = { contentType: 'image/png', byteSize: bytes.length, sha256 };
  const ticket = await call<{ receiptId: string; path: string }>(
    'POST',
    '/v1/receipts/uploads',
    described,
  );
  files.set(ticket.path, bytes);
  if (script) scripts.set(ticket.receiptId, script);
  if (order) orders.set(ticket.receiptId, order);
  await call('POST', '/v1/receipts', { id: ticket.receiptId, source, ...described });
  receipts[name] = ticket.receiptId;
}
const [haiku, sonnet] = COMPARISON_MODELS;
/** The line of the receipt each field was read from, as a model asked for them answers (GAP-14). */
const linesOf = (lines: Partial<Record<string, string>>) => ({
  sources: {
    merchant: null,
    date: null,
    time: null,
    address: null,
    currency: null,
    total: null,
    subtotal: null,
    taxes: null,
    tip: null,
    fees: null,
    cardLastFour: null,
    ...lines,
  },
});
await capture(
  'coffee',
  'camera',
  both(
    reading(
      'Blue Bottle Coffee',
      '2026-09-30',
      'USD',
      '6.50',
      linesOf({
        merchant: 'BLUE BOTTLE COFFEE',
        date: '09/30/2026 08:12 AM',
        currency: 'USD $',
        total: 'TOTAL .................. $6.50',
      }),
    ),
  ),
);
await capture('folio', 'upload', {
  [haiku]: reading('The Ritz-Carlton, Half Moon Bay', '2026-10-01', 'USD', '1284.37', {
    documentType: 'hotel_folio',
  }),
  [sonnet]: reading(
    'The Ritz-Carlton Half Moon Bay — Folio 88213-A',
    '2026-10-01',
    'USD',
    '1248.37',
    {
      documentType: 'hotel_folio',
      taxes: [{ label: 'Occupancy tax', value: '147.00', confidence: 'high' }],
    },
  ),
});
// When and where a ride was bought, as its receipt prints them (FR-INT-17).
const eppley = {
  time: { value: '18:42', confidence: 'high' },
  address: {
    printed: 'Eppley Airfield, 4501 Abbott Dr, Omaha, NE 68110',
    city: 'Omaha',
    region: 'NE',
    country: 'US',
    confidence: 'high',
  },
};
// A ride: its booking fee and airport surcharge are neither tax nor tip, and still add up.
await capture(
  'uber',
  'camera',
  both(
    reading('Uber', '2026-09-30', 'USD', '31.45', {
      ...eppley,
      documentType: 'ride_receipt',
      subtotal: { value: '25.20', confidence: 'high' },
      fees: [
        { label: 'Booking Fee', value: '2.75', confidence: 'high' },
        { label: 'Airport Surcharge', value: '1.50', confidence: 'high' },
      ],
      tip: { value: '2.00', confidence: 'high' },
    }),
  ),
);
// The same ride sent again: read alike, at the same time and place, so it is held as an
// exact copy (FR-INT-18, ADR-0031).
await capture(
  'uberAgain',
  'upload',
  both(
    reading('Uber Technologies Inc.', '2026-09-30', 'USD', '31.45', {
      ...eppley,
      documentType: 'ride_receipt',
      subtotal: { value: '25.20', confidence: 'high' },
      fees: [
        { label: 'Booking Fee', value: '2.75', confidence: 'high' },
        { label: 'Airport Surcharge', value: '1.50', confidence: 'high' },
      ],
      tip: { value: '2.00', confidence: 'high' },
    }),
  ),
);
// A dinner's itemized bill, then the card slip with the tip five minutes on: held as a
// possible duplicate, its total different (ADR-0031).
const juniper = (time: string) => ({
  time: { value: time, confidence: 'high' },
  address: {
    printed: '1520 Harney St, Omaha, NE 68102',
    city: 'Omaha',
    region: 'NE',
    country: 'US',
    confidence: 'high',
  },
});
await capture(
  'dinner',
  'camera',
  both(reading('Juniper & Rye', '2026-09-29', 'USD', '84.50', juniper('19:58'))),
);
await capture(
  'dinnerSlip',
  'camera',
  both(
    reading('Juniper & Rye', '2026-09-29', 'USD', '101.40', {
      ...juniper('20:03'),
      tip: { value: '16.90', confidence: 'high' },
    }),
  ),
);
await capture('steak', 'camera', {
  [haiku]: reading('Pappas Bros. Steakhouse', '2026-09-23', 'USD', '93.10', {
    tip: { value: '0', confidence: 'low' },
  }),
  [sonnet]: reading('Pappas Bros. Steakhouse', '2026-09-23', 'USD', '98.10'),
});
await capture(
  'lufthansa',
  'upload',
  both(reading('Lufthansa', '2026-09-28', 'EUR', '412.80', { documentType: 'airline_ticket' })),
);
await capture('fallback', 'upload', {
  [haiku]: 'refuse',
  [sonnet]: 'refuse',
  [FALLBACK_MODEL]: reading('Verve Coffee Roasters', '2026-10-02', 'USD', '12.25'),
});
await capture('failed', 'camera', { [haiku]: 'refuse', [sonnet]: 'refuse' });
// Read alike and with confidence, but the parts miss the tip, and a date a week from now.
await capture(
  'sums',
  'camera',
  both(
    reading('Bayside Grill', '2026-09-24', 'USD', '58.43', {
      subtotal: { value: '45.50', confidence: 'high' },
      taxes: [{ label: 'Sales tax', value: '4.43', confidence: 'high' }],
    }),
  ),
);
const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
await capture('future', 'upload', both(reading('Hyatt Regency Omaha', nextWeek, 'USD', '212.40')));
// An order confirmation: read with confidence, and still a summary, so it waits (Q10).
await capture(
  'summary',
  'upload',
  both(reading('Amazon.com', '2026-09-29', 'USD', '86.97', { documentType: 'purchase_summary' })),
);
await capture('processing', 'upload');
// Read under the AI model settings (FR-INT-16): Ready on one confident reading by the primary;
// a back-up's unsure reading when the primary couldn't; and nothing read, every model off.
await capture(
  'primaryRead',
  'camera',
  { [sonnet]: reading('Verve Coffee Roasters', '2026-09-30', 'USD', '9.75') },
  [sonnet, haiku],
);
await capture(
  'backupRead',
  'camera',
  {
    [sonnet]: 'refuse',
    [haiku]: reading('Upstream Brewing Company', '2026-09-30', 'USD', '41.20', {
      total: { value: '41.20', confidence: 'low' },
    }),
  },
  [sonnet, haiku],
);
await capture('notRead', 'upload', {}, []);
// A ride in Chicago, and a lunch on no trip: a local expense, Ready, given a reason below.
await capture('chicago', 'camera', both(reading('Lyft', '2026-09-02', 'USD', '24.60')));
// A garage ticket read alike and Ready, its merchant then corrected with a tap (GAP-14).
await capture(
  'parking',
  'camera',
  both(
    reading(
      'SP+ Parking',
      '2026-09-29',
      'USD',
      '18.00',
      linesOf({
        merchant: 'SP+ PARKING / GARAGE 114',
        date: 'ENTRY 09/29/26 07:58 / EXIT 09/29/26 17:41',
        total: 'AMOUNT PAID $18.00',
      }),
    ),
  ),
);
await capture('lunch', 'camera', both(reading('Zuni Café', '2026-09-27', 'USD', '48.20')));
// Journeys and stays (FR-INT-20, FR-INT-21), read as a model asked for them answers: a ride
// with its pickup and drop-off, a flight with its airports, a folio with its stay, and a
// folio whose dates can't be right, which needs a look rather than a wrong count of nights.
const end = (value: string) => ({ value, confidence: 'high' });
await capture(
  'ride',
  'camera',
  both(
    reading('Lyft', '2026-09-30', 'USD', '18.40', {
      documentType: 'ride_receipt',
      journey: { from: end('Hilton Omaha, 1001 Cass St'), to: end('1520 Harney St') },
      stay: null,
    }),
  ),
);
await capture(
  'flight',
  'upload',
  both(
    reading('United Airlines', '2026-09-29', 'USD', '389.20', {
      documentType: 'airline_ticket',
      journey: { from: end('SFO'), to: end('OMA') },
      stay: null,
    }),
  ),
);
await capture(
  'stay',
  'upload',
  both(
    reading('Hilton Omaha', '2026-10-01', 'USD', '412.60', {
      documentType: 'hotel_folio',
      journey: null,
      stay: { checkIn: end('2026-09-29'), checkOut: end('2026-10-01') },
    }),
  ),
);
await capture(
  'stayUnsure',
  'upload',
  both(
    reading('Embassy Suites Omaha Downtown', '2026-09-30', 'USD', '236.80', {
      documentType: 'hotel_folio',
      journey: null,
      stay: { checkIn: end('2026-10-01'), checkOut: end('2026-09-30') },
    }),
  ),
);
// A hotel folio read line by line (FR-INT-22), on the Omaha trip; and a bistro bill whose lines
// miss its subtotal, so they can't be left out or split by line (ADR-0041).
await capture(
  'folioLines',
  'upload',
  both(
    reading('Hotel Indigo Omaha', '2026-10-01', 'USD', '1129.10', {
      documentType: 'hotel_folio',
      subtotal: { value: '985.50', confidence: 'high' },
      taxes: [{ label: 'Occupancy tax', value: '128.12', confidence: 'high' }],
      fees: [{ label: 'Resort fee', value: '15.48', confidence: 'high' }],
      lineItems: [
        { description: 'Room, 2 nights', quantity: '2', amount: '898.00' },
        { description: 'Minibar', quantity: null, amount: '18.50' },
        { description: 'Room service', quantity: null, amount: '46.00' },
        { description: 'Valet parking', quantity: null, amount: '23.00' },
      ],
    }),
  ),
);
await capture(
  'linesShort',
  'camera',
  both(
    reading('Harney Street Bistro', '2026-09-30', 'USD', '58.43', {
      subtotal: { value: '45.50', confidence: 'high' },
      taxes: [{ label: 'Sales tax', value: '4.43', confidence: 'high' }],
      tip: { value: '8.50', confidence: 'high' },
      lineItems: [
        { description: 'Steak frites', quantity: '1', amount: '29.00' },
        { description: 'Caesar salad', quantity: '1', amount: '13.50' },
      ],
    }),
  ),
);

// A confirmed correction, an expense edited away from its receipt, one put on a trip by hand.
await call('POST', `/v1/receipts/${receipts.steak}/confirm`, {
  model: sonnet,
  corrections: { tip: '15.00', total: '108.10' },
});
await call('POST', `/v1/receipts/${receipts.parking}/corrections`, {
  corrections: { merchant: 'SP+ Parking — Omaha Civic Center Garage' },
});
const expenseOf = async (name: string) =>
  (await call<{ expenseId: string }>('GET', `/v1/receipts/${receipts[name]}`)).expenseId;
await call('PATCH', `/v1/expenses/${await expenseOf('coffee')}`, {
  amount: '7.25',
  merchant: 'Blue Bottle Coffee — Oxbow Public Market',
});
await call('PUT', `/v1/expenses/${await expenseOf('lufthansa')}/trip`, { tripId: trips.omaha.id });
// Categories and types (FR-EXP-11): the hotel folio's chosen by hand; the rest show a
// suggestion, or that they have none, such as the dinner at Juniper & Rye.
const catalog = await call<{
  categories: { id: string; name: string }[];
  types: { id: string; name: string }[];
}>('GET', '/v1/categories');
await call('PUT', `/v1/expenses/${await expenseOf('folio')}/category`, {
  categoryId: catalog.categories.find((c) => c.name === 'Travel')!.id,
  typeId: catalog.types.find((t) => t.name === 'Lodging')!.id,
});
// The folio read line by line: lodging, its room service split off to Meals (FR-EXP-15) and
// its minibar left out as personal (FR-EXP-16).
const folioLines = await expenseOf('folioLines');
await call('PUT', `/v1/expenses/${folioLines}/category`, {
  categoryId: catalog.categories.find((c) => c.name === 'Travel')!.id,
  typeId: catalog.types.find((t) => t.name === 'Lodging')!.id,
});
await call('PUT', `/v1/expenses/${folioLines}/split`, {
  basis: 'lines',
  lines: [
    {
      position: 3,
      categoryId: catalog.categories.find((c) => c.name === 'Meals')!.id,
      typeId: catalog.types.find((t) => t.name === 'Business meal')!.id,
    },
  ],
});
await call('PUT', `/v1/expenses/${folioLines}/lines/2/exclusion`, { reason: 'personal' });

const expenses: Record<string, string> = {};
for (const name of Object.keys(receipts)) expenses[name] = await expenseOf(name);
// A drive to the airport on the Omaha trip's first day (FR-CAP-03): it files to the trip.
expenses.mileage = (
  await call<{ id: string }>('POST', '/v1/mileage', {
    date: '2026-09-29',
    destination: 'Eppley Airfield, Omaha',
    purpose: 'Drive to the airport for the Q4 architect meeting',
    miles: '38.4',
  })
).id;
// And the drive home on its last day, Oct 1, so Home shows October's business miles (#73).
await call('POST', '/v1/mileage', {
  date: '2026-10-01',
  destination: '12 Elm St, Omaha',
  purpose: 'Drive home from the airport after the Q4 architect meeting',
  miles: '36.15',
});
// The organization's own rate a mile from Nov 1, and the IRS rate again from Mar 1 (Q28, #77),
// set after the drive, which keeps the IRS rate it was logged at.
await call('PUT', '/v1/settings/mileage-rates/2026-11-01', { perMile: '0.65' });
await call('PUT', '/v1/settings/mileage-rates/2027-03-01', { perMile: null });
// Route mileage (FR-CAP-04): the organization's OpenRouteService key, Riley's saved places,
// a round trip measured and claimed at more miles with a reason (Q33), and a drive with a stop
// that can't be found, which needs a look.
await call('PUT', '/v1/settings/mileage/route-key', { apiKey: 'ors-bench-key-0000-wxyz' });
await call('POST', '/v1/me/places', { name: 'Office', address: '1520 Harney St, Omaha, NE' });
await call('POST', '/v1/me/places', {
  name: 'Acme HQ',
  address: 'Acme HQ, 1200 Dodge St, Omaha, NE',
});
expenses.routeMeasured = (
  await call<{ id: string }>('POST', '/v1/mileage/routes', {
    date: '2026-09-30',
    purpose: 'Client visit at Acme, then the airport',
    stops: [
      '1520 Harney St, Omaha, NE',
      'Acme HQ, 1200 Dodge St, Omaha, NE',
      'Eppley Airfield, Omaha, NE',
    ],
    roundTrip: true,
  })
).id;
await call('PUT', `/v1/mileage/${expenses.routeMeasured}/route/miles`, {
  miles: '78',
  reason: 'Abbott Drive was closed, so I took the detour by the river',
});
expenses.routeNotFound = (
  await call<{ id: string }>('POST', '/v1/mileage/routes', {
    date: '2026-09-30',
    purpose: 'Site visit for the Q4 architect meeting',
    stops: ['1520 Harney St, Omaha, NE', '9 Nowhere Lane, Omaha, NE'],
  })
).id;

// Reports (#23): the hourly schedule puts the trips that have ended, and the local expenses,
// on one open report; Chicago then moves to a report of its own, which closes.
await call('PUT', `/v1/expenses/${expenses.lunch}/justification`, {
  justification: 'Lunch with the Acme architecture team',
});
await runReportSchedule(db, organization.id, new Date());
const { reportId: closed } = await call<{ reportId: string }>(
  'PUT',
  `/v1/trips/${trips.chicago.id}/report`,
  { newReport: true },
);
await call('POST', `/v1/reports/${closed}/close`);
const open = (
  await call<{ trips: { id: string; reportId: string | null }[] }>('GET', '/v1/trips')
).trips.find((t) => t.id === trips.omaha.id)?.reportId;
if (!open) throw new Error('The schedule put no trip on a report');
// Approval (#24): Sam's drive goes on a report of its own, submitted to Riley, the only one
// who can approve it then. Casey then joins as an approver, Riley's own drive is submitted to
// Casey, and Casey returns it with the drive rejected.
const drive = (who: string, date: string, destination: string, purpose: string) =>
  callAs<{ id: string }>(who, 'POST', '/v1/mileage', { date, destination, purpose, miles: '14' });
const submitted = async (who: string, expenseId: string) => {
  const { reportId } = await callAs<{ reportId: string }>(
    who,
    'PUT',
    `/v1/expenses/${expenseId}/report`,
    { newReport: true },
  );
  await callAs(who, 'POST', `/v1/reports/${reportId}/close`);
  await callAs(who, 'POST', `/v1/reports/${reportId}/submit`);
  return reportId;
};
const samDrive = await drive('sam', '2026-09-15', 'Acme HQ', 'Client visit at Acme');
const toApprove = await submitted('sam', samDrive.id);
const casey = await call<Made>('POST', '/v1/settings/people/invites', {
  role: 'approver',
  label: 'Casey',
});
await callAs('casey', 'POST', '/v1/invites/accept', { token: casey.token });
const officeDrive = await drive('riley', '2026-09-16', 'The office', 'Drive to the office');
const returned = await submitted(E2E_USER, officeDrive.id);
await callAs('casey', 'POST', `/v1/reports/${returned}/return`, {
  comment: 'Claim client visits only: the office isn’t one',
  rejections: [{ expenseId: officeDrive.id, reason: 'A drive to your own office is commuting' }],
});

// The organization's details and its duplicate window (#63, #64), set after the reports so
// they open as they always have.
await call('PATCH', '/v1/settings/organization', {
  name: 'Acme Field Services',
  country: 'US',
  locale: 'en-US',
  timeZone: 'America/Chicago',
  address: '1520 Harney St, Suite 400\nOmaha, NE 68102',
  industry: 'Professional services',
  size: '2_10',
});
await call('PUT', '/v1/settings/duplicate-window', { minutes: 45 });

// The open report's flight in euros is converted to dollars (#62), with the ECB's rates for
// the days before it faked here: the bench never calls the real source.
const ecb = (url: string) => {
  const days = /startPeriod=(\d{4}-\d{2}-\d{2})&endPeriod=(\d{4}-\d{2}-\d{2})/.exec(url);
  const rows = days ? [`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${days[2]},1.1723,A`] : [];
  const csv = [
    'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
    ...rows,
  ];
  return Promise.resolve(new Response(csv.join('\n'), { status: 200 }));
};
await convertOrganization(conversionPorts({ db, fetch: ecb as typeof fetch }), organization.id);
// Two emails from Riley's own address that filed nothing (#59), kept as the email workflow keeps
// them: one a mail system changed after it was signed, so nothing proved it was Riley's, and
// one with nothing in it to read.
const [riley] = await findMemberships(db, E2E_USER);
if (!riley) throw new Error('The bench has no membership for its user');
for (const [n, subject, status, senderProblem] of [
  [1, 'Fwd: Your Tuesday evening trip with Uber', 'unverified', 'signature_failed'],
  [2, 'Receipt', 'no_attachments', null],
] as const) {
  await withOrg(db, organization.id, (tx) =>
    recordInboundEmail(
      tx,
      organization.id,
      {
        id: derivedId(`bench-email:${n}`),
        memberId: riley.memberId,
        provider: 'bird',
        providerMessageId: `rem_bench_${n}`,
        fromAddress: `${E2E_USER}@example.com`,
        subject,
        sentAt: new Date(),
        status,
        senderProblem,
        bodyText: null,
      },
      [],
      E2E_USER,
    ),
  );
}

const seeded: Seeded = {
  trips: {
    omaha: trips.omaha.id,
    houston: trips.houston.id,
    long: trips.long.id,
    empty: trips.empty.id,
  },
  receipts,
  expenses,
  reports: { open, closed, toApprove, returned },
  invites: { join: join.token, revoked: revoked.token },
};

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '/';
    if (url === '/__bench/seeded') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seeded));
      return;
    }
    if (url.startsWith('/files/')) {
      const bytes = files.get(decodeURIComponent(url.slice('/files/'.length)));
      res.writeHead(bytes ? 200 : 404, { 'content-type': 'image/png' });
      res.end(bytes ? Buffer.from(bytes) : undefined);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await app.fetch(
      new Request(`http://127.0.0.1:${BENCH_PORT}${url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length && req.method !== 'GET' ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch((error: unknown) => {
    console.error(error);
    res.writeHead(500);
    res.end();
  });
});
server.listen(BENCH_PORT, '127.0.0.1', () => {
  console.log(`Bench API on ${BENCH_PORT}, database ${database}.`);
});
