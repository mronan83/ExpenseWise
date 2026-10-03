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
  createSecretBox,
  dbExpenseStore,
  dbReceiptStore,
  dbHomeStore,
  dbTripStore,
  dbWorkspaceStore,
} from '@expensewise/api';
import { createDatabase, setRolePasswords } from '@expensewise/db';
import { runMigrations } from '@expensewise/db/migrate';
import { COMPARISON_MODELS, FALLBACK_MODEL } from '@expensewise/extraction';
import { readWith, receiptReadingPorts, settleReading } from '@expensewise/workflows';
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
};

/** What each model answers for a receipt: a reading, or nothing usable. */
type Script = Partial<Record<string, Record<string, unknown> | 'refuse'>>;
const scripts = new Map<string, Script>();

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
  taxes: [],
  tip: null,
  cardLastFour: null,
  lineItems: [],
  ...more,
});
const both = (r: Record<string, unknown>): Script => ({
  [COMPARISON_MODELS[0]]: r,
  [COMPARISON_MODELS[1]]: r,
});

/** The real reading workflow, with each model's answer scripted. */
async function dispatch(
  events: readonly { orgId: string; outboxId: string; payload: unknown }[],
): Promise<void> {
  for (const event of events) {
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
      assuranceLevel: 'aal1',
      sessionId: 'bench',
      issuedAt: new Date(),
    }),
  workspace: dbWorkspaceStore(db),
  receipts: dbReceiptStore(db),
  expenses: dbExpenseStore(db),
  trips: dbTripStore(db),
  home: dbHomeStore(db),
  files: store,
  dispatch,
  secrets: createSecretBox('bench-only-secret-0123456789'),
  verifyProviderKey: () => Promise.resolve({ ok: true, authScheme: 'api_key' }),
});

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${E2E_USER}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

// The organization, a key, trips, receipts in every state, and expenses changed by hand.
await call('POST', '/v1/me/organization');
await call('PUT', '/v1/settings/ai-providers/anthropic', { apiKey: 'sk-ant-bench-0000-wxyz' });
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
};

const receipts: Record<string, string> = {};
async function capture(name: string, source: 'camera' | 'upload', script?: Script) {
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
  await call('POST', '/v1/receipts', { id: ticket.receiptId, source, ...described });
  receipts[name] = ticket.receiptId;
}
const [haiku, sonnet] = COMPARISON_MODELS;
await capture('coffee', 'camera', both(reading('Blue Bottle Coffee', '2026-09-30', 'USD', '6.50')));
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
await capture(
  'uber',
  'camera',
  both(
    reading('Uber', '2026-09-30', 'USD', '31.45', { tip: { value: '2.00', confidence: 'high' } }),
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
await capture('processing', 'upload');

// A confirmed correction, an expense edited away from its receipt, one put on a trip by hand.
await call('POST', `/v1/receipts/${receipts.steak}/confirm`, {
  model: sonnet,
  corrections: { tip: '15.00', total: '108.10' },
});
const expenseOf = async (name: string) =>
  (await call<{ expenseId: string }>('GET', `/v1/receipts/${receipts[name]}`)).expenseId;
await call('PATCH', `/v1/expenses/${await expenseOf('coffee')}`, {
  amount: '7.25',
  merchant: 'Blue Bottle Coffee — Oxbow Public Market',
});
await call('PUT', `/v1/expenses/${await expenseOf('lufthansa')}/trip`, { tripId: trips.omaha.id });

const expenses: Record<string, string> = {};
for (const name of Object.keys(receipts)) expenses[name] = await expenseOf(name);
const seeded: Seeded = {
  trips: {
    omaha: trips.omaha.id,
    houston: trips.houston.id,
    long: trips.long.id,
    empty: trips.empty.id,
  },
  receipts,
  expenses,
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
