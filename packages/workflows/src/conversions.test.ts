import type { ConversionRun, Database, FetchedRates, RateRequest } from '@expensewise/db';
import { euroRate } from '@expensewise/domain';
import { InngestTestEngine } from '@inngest/test';
import { NonRetriableError } from 'inngest';
import { describe, expect, it, vi } from 'vitest';
import {
  amountConversionFunction,
  CONVERSION_SWEEP,
  conversionPorts,
  conversionSweepFunction,
  convertOrganization,
  ecbRates,
  parseEcbCsv,
  rateWindows,
  sweepConversions,
  type ConversionPorts,
} from './conversions.ts';
import { createWorkflowClient } from './client.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';

// The ECB's answer as it comes, abridged: a title with a quoted comma, and a day with no value.
const HEADER =
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL,UNIT';
const row = (currency: string, day: string, value: string) =>
  `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${day},${value},A,"ECB reference exchange rate, ${currency}/Euro, 2.15 pm (C.E.T.)",${currency}`;
const CSV = [
  HEADER,
  row('GBP', '2026-09-25', '0.87265'),
  row('USD', '2026-09-25', '1.1712'),
  row('USD', '2026-09-28', '1.1723'),
  row('USD', '2026-09-29', ''),
  row('BGN', '2025-09-25', '1.9558'),
].join('\r\n');

describe('the ECB’s reference rates (ADR-0034)', () => {
  it('reads each currency’s rate and its day from the answer, whatever the columns’ order', () => {
    expect(parseEcbCsv(CSV)).toEqual([
      euroRate({ currency: 'GBP', date: '2026-09-25', rate: '0.87265' }),
      euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.1712' }),
      euroRate({ currency: 'USD', date: '2026-09-28', rate: '1.1723' }),
    ]);
    expect(parseEcbCsv('')).toEqual([]);
    expect(() => parseEcbCsv('KEY,CURRENCY,TIME_PERIOD\nx,USD,2026-09-25')).toThrow(
      NonRetriableError,
    );
  });

  it('asks once for each run of purchase dates, from ten days before the first', () => {
    expect(
      rateWindows([
        { date: '2026-09-28', currencies: ['USD'] },
        { date: '2026-09-27', currencies: ['GBP', 'USD'] },
        { date: '2027-11-02', currencies: ['JPY'] },
      ]),
    ).toEqual([
      { start: '2026-09-17', end: '2026-09-28', currencies: ['GBP', 'USD'] },
      { start: '2027-10-23', end: '2027-11-02', currencies: ['JPY'] },
    ]);
  });

  it('fetches from the ECB’s data API, never anything else, and reads its answer', async () => {
    const asked: string[] = [];
    // ecbRates asks with a URL string.
    const fake = vi.fn((url: string) => {
      asked.push(url);
      return Promise.resolve(new Response(CSV, { status: 200 }));
    }) as unknown as typeof fetch;
    const rates = await ecbRates(fake)([
      { date: '2026-09-27', currencies: ['GBP', 'USD'] },
      { date: '2026-09-28', currencies: ['USD'] },
    ]);
    expect(asked).toEqual([
      'https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?startPeriod=2026-09-17&endPeriod=2026-09-28&format=csvdata',
    ]);
    expect(rates).toHaveLength(3);
  });

  it('takes no series as no rate, tries a busy source again, and gives up on a bad request', async () => {
    const answering = (status: number) =>
      (() => Promise.resolve(new Response('', { status }))) as unknown as typeof fetch;
    const ask: RateRequest[] = [{ date: '2026-09-27', currencies: ['USD'] }];
    expect(await ecbRates(answering(404))(ask)).toEqual([]);
    for (const status of [429, 503]) {
      const error = await ecbRates(answering(status))(ask).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NonRetriableError);
    }
    await expect(ecbRates(answering(400))(ask)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

const run = (over: Partial<ConversionRun> = {}): ConversionRun => ({
  skipped: false,
  followed: 0,
  converted: 0,
  unavailable: 0,
  needed: [],
  ...over,
});

function world(first: ConversionRun, second = run()) {
  const calls: { fetched?: FetchedRates }[] = [];
  const fetched: RateRequest[][] = [];
  const ports: ConversionPorts = {
    convert: (_org, _now, f) => {
      calls.push({ fetched: f });
      return Promise.resolve(calls.length === 1 ? first : second);
    },
    fetchRates: (requests) => {
      fetched.push([...requests]);
      return Promise.resolve([euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.1712' })]);
    },
    dueOrganizations: () => Promise.resolve([ORG]),
  };
  return { ports, calls, fetched };
}

describe('converting an organization’s amounts', () => {
  const needed = [{ date: '2026-09-27', currencies: ['USD' as const] }];

  it('converts what it can, fetches the rates still needed, then converts with them', async () => {
    const w = world(run({ converted: 1, needed }), run({ converted: 2 }));
    expect(await convertOrganization(w.ports, ORG)).toEqual({
      orgId: ORG,
      skipped: false,
      followed: 0,
      converted: 3,
      unavailable: 0,
      waiting: 0,
    });
    expect(w.fetched).toEqual([needed]);
    expect(w.calls[1]?.fetched).toEqual({
      asked: needed,
      rates: [euroRate({ currency: 'USD', date: '2026-09-25', rate: '1.1712' })],
    });
  });

  it('asks the source nothing when nothing needs a rate, or the feature is off', async () => {
    for (const first of [run({ converted: 1 }), run({ skipped: true })]) {
      const w = world(first);
      await convertOrganization(w.ports, ORG);
      expect(w.fetched).toEqual([]);
      expect(w.calls).toHaveLength(1);
    }
  });

  it('carries on past an organization that fails, then fails the sweep so it is retried', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = world(run({ converted: 1 }));
    const failing: ConversionPorts = {
      ...w.ports,
      dueOrganizations: () => Promise.resolve(['broken', ORG]),
      convert: (org, now, f) =>
        org === 'broken' ? Promise.reject(new Error('broken')) : w.ports.convert(org, now, f),
    };
    await expect(sweepConversions(failing)).rejects.toThrow(/1 organization/);
    expect(log).toHaveBeenCalledWith(
      'amount-conversion-sweep',
      expect.objectContaining({ organizations: 2, converted: 1, failed: 1 }),
    );
    log.mockRestore();
  });

  it('finds nothing due anywhere when the server’s override switches the feature off', async () => {
    const ports = conversionPorts({
      db: {} as Database,
      overrides: 'reports.currency-conversion=off',
    });
    expect(await ports.dueOrganizations(new Date())).toEqual([]);
  });
});

describe('the conversion functions', () => {
  const client = createWorkflowClient({ isDev: true });

  it('run when asked, or when the owner switches the feature on, one at a time per organization', () => {
    const fn = amountConversionFunction(client, () => world(run()).ports);
    expect(fn.opts.triggers).toEqual([
      { event: 'report.conversions_due' },
      {
        event: 'feature.switched',
        if: "event.data.flag == 'reports.currency-conversion' && event.data.enabled == true",
      },
    ]);
    expect(fn.opts.concurrency).toEqual({ key: 'event.data.orgId', limit: 1 });
    const sweep = conversionSweepFunction(client, () => world(run()).ports);
    expect(sweep.opts.triggers).toEqual([{ cron: CONVERSION_SWEEP }]);
  });

  it('converts the organization the event names', async () => {
    const w = world(run({ converted: 1 }));
    const t = new InngestTestEngine({
      function: amountConversionFunction(client, () => w.ports),
      events: [{ name: 'report.conversions_due', data: { orgId: ORG, outboxId: 'ob-1' } }],
    });
    const { result, error } = await t.execute();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ orgId: ORG, converted: 1 });
  });
});
