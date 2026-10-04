import {
  CONVERSION_FLAG,
  CONVERSIONS_DUE,
  convertAmounts,
  conversionWorkDue,
  FEATURE_SWITCHED,
  featureOverride,
  type ConversionRun,
  type Database,
  type FetchedRates,
  type RateRequest,
} from '@expensewise/db';
import { euroRate, isCurrencyCode, lookbackDays, type EuroRate } from '@expensewise/domain';
import { NonRetriableError, type Inngest } from 'inngest';
import { checkedDatabase } from './receipt-ports.ts';

/** The ECB's data API for its euro reference rates: free, public, and with no key. */
export const ECB_RATES_URL = 'https://data-api.ecb.europa.eu/service/data/EXR';

/**
 * The safety net: hourly, at 37 minutes past, clear of the report schedule at 7 past. A
 * request to convert normally comes as something changes; the sweep catches what a failed
 * fetch or a missed request left converting, within the hour. About 720 runs a month.
 */
export const CONVERSION_SWEEP = '37 * * * *';

/** The days a run may ask for in one request; anything wider is asked for in parts. */
const MAX_SPAN_DAYS = 366;

/** Splits one CSV line into its fields, quotes and doubled quotes included. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields;
}

/**
 * The rates in an answer from the ECB in `csvdata` format: its CURRENCY, TIME_PERIOD and
 * OBS_VALUE columns, wherever they are. A row with no value, or one for a currency we don't
 * support, is left out.
 */
export function parseEcbCsv(text: string): EuroRate[] {
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!header) return [];
  const columns = csvFields(header);
  const at = (name: string) => {
    const i = columns.indexOf(name);
    if (i < 0) throw new NonRetriableError(`The ECB's answer has no ${name} column`);
    return i;
  };
  const [currency, period, value] = [at('CURRENCY'), at('TIME_PERIOD'), at('OBS_VALUE')];
  return rows.flatMap((row) => {
    const f = csvFields(row);
    const code = f[currency] ?? '';
    const rate = f[value] ?? '';
    if (!isCurrencyCode(code) || !/^\d+(\.\d+)?$/.test(rate)) return [];
    return [euroRate({ currency: code, date: f[period] ?? '', rate })];
  });
}

/** One question to the source: currencies over a run of days. */
interface Window {
  readonly start: string;
  readonly end: string;
  readonly currencies: readonly string[];
}

/** The fewest questions that cover every request's lookback, a year at most each. */
export function rateWindows(requests: readonly RateRequest[]): Window[] {
  const sorted = [...requests].sort((a, b) => a.date.localeCompare(b.date));
  const windows: { start: string; end: string; currencies: Set<string> }[] = [];
  for (const r of sorted) {
    const start = lookbackDays(r.date).at(-1)!;
    const last = windows.at(-1);
    if (last && daysFrom(last.start, r.date) <= MAX_SPAN_DAYS) {
      last.end = r.date;
      r.currencies.forEach((c) => last.currencies.add(c));
    } else windows.push({ start, end: r.date, currencies: new Set(r.currencies) });
  }
  return windows.map((w) => ({ ...w, currencies: [...w.currencies].sort() }));
}

const daysFrom = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * Fetches the ECB's reference rates for these requests: each currency against the euro, over
 * each purchase date's lookback. One attempt per question with a 30-second limit; a busy or
 * failing source throws so the workflow tries again, and a currency it has no series for
 * answers 404, which is no rate rather than an error.
 */
export function ecbRates(fetchImpl: typeof fetch = fetch) {
  return async (requests: readonly RateRequest[]): Promise<EuroRate[]> => {
    const rates: EuroRate[] = [];
    for (const w of rateWindows(requests)) {
      if (w.currencies.length === 0) continue;
      const url =
        `${ECB_RATES_URL}/D.${w.currencies.join('+')}.EUR.SP00.A` +
        `?startPeriod=${w.start}&endPeriod=${w.end}&format=csvdata`;
      const response = await fetchImpl(url, {
        headers: { Accept: 'text/csv' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) continue;
      if (!response.ok) {
        const detail = `The ECB answered ${response.status} for ${w.currencies.join(', ')} from ${w.start}`;
        const retry = [408, 429].includes(response.status) || response.status >= 500;
        throw retry ? new Error(detail) : new NonRetriableError(detail);
      }
      rates.push(...parseEcbCsv(await response.text()));
    }
    return rates;
  };
}

/** What converting needs from the database and the rate source. */
export interface ConversionPorts {
  /** Converts what it can in one organization, with any rates fetched (convertAmounts). */
  convert(orgId: string, now: Date, fetched?: FetchedRates): Promise<ConversionRun>;
  fetchRates(requests: readonly RateRequest[]): Promise<EuroRate[]>;
  /** The organizations with amounts to convert, as ids only (conversion_work_due()). */
  dueOrganizations(now: Date): Promise<string[]>;
  now?(): Date;
}

export interface OrganizationConversion {
  readonly orgId: string;
  readonly skipped: boolean;
  readonly followed: number;
  readonly converted: number;
  readonly unavailable: number;
  /** Purchase dates still waiting for a rate after this run. */
  readonly waiting: number;
}

/**
 * Converts one organization's waiting amounts (ADR-0034): first what the rates already
 * recorded allow, then, if some need rates, fetches them from the source and converts again.
 * Each pass is one transaction as the app; repeating it is safe.
 */
export async function convertOrganization(
  ports: ConversionPorts,
  orgId: string,
): Promise<OrganizationConversion> {
  const now = () => ports.now?.() ?? new Date();
  const first = await ports.convert(orgId, now());
  let last = first;
  if (!first.skipped && first.needed.length > 0) {
    const rates = await ports.fetchRates(first.needed);
    last = await ports.convert(orgId, now(), { asked: first.needed, rates });
  }
  return {
    orgId,
    skipped: first.skipped,
    followed: first.followed + (last === first ? 0 : last.followed),
    converted: first.converted + (last === first ? 0 : last.converted),
    unavailable: first.unavailable + (last === first ? 0 : last.unavailable),
    waiting: last === first ? first.needed.length : last.needed.length,
  };
}

export interface ConversionSweepSummary {
  readonly organizations: number;
  readonly converted: number;
  readonly unavailable: number;
  readonly failed: number;
}

/**
 * The hourly sweep: converts in each organization with something waiting. One failing doesn't
 * hold up the rest; the run then fails, so it is retried. Logs counts only.
 */
export async function sweepConversions(ports: ConversionPorts): Promise<ConversionSweepSummary> {
  const organizations = await ports.dueOrganizations(ports.now?.() ?? new Date());
  const done: OrganizationConversion[] = [];
  const failures: unknown[] = [];
  for (const orgId of organizations) {
    try {
      done.push(await convertOrganization(ports, orgId));
    } catch (error) {
      failures.push(error);
    }
  }
  const summary: ConversionSweepSummary = {
    organizations: organizations.length,
    converted: done.reduce((n, d) => n + d.converted, 0),
    unavailable: done.reduce((n, d) => n + d.unavailable, 0),
    failed: failures.length,
  };
  console.log('amount-conversion-sweep', summary);
  if (failures.length > 0) {
    throw new AggregateError(failures, `Converting failed for ${failures.length} organization(s)`);
  }
  return summary;
}

export interface ConversionDeps {
  /** As expensewise_app; only the sweep's question runs outside an organization. */
  readonly db: Database;
  readonly fetch?: typeof fetch;
  /** FLAG_OVERRIDES, as the server reads it. */
  readonly overrides?: string;
}

/** Converting on Postgres and the ECB's data API. */
export function conversionPorts(deps: ConversionDeps): ConversionPorts {
  const { safe, inOrg } = checkedDatabase(deps.db);
  const forced = () => featureOverride(CONVERSION_FLAG, deps.overrides);
  return {
    convert: (orgId, now, fetched) => inOrg(orgId, (tx) => convertAmounts(tx, orgId, now, fetched)),
    fetchRates: ecbRates(deps.fetch),
    async dueOrganizations(now) {
      // Switched off for everyone by the override: nothing is due anywhere.
      if (forced() === false) return [];
      await safe();
      return conversionWorkDue(deps.db, now, forced() === true);
    },
  };
}

function organizationOf(data: unknown): string {
  const { orgId } = (data ?? {}) as Record<string, unknown>;
  if (typeof orgId !== 'string') throw new NonRetriableError('The event names no orgId');
  return orgId;
}

/**
 * Converts an organization's amounts when asked: something on a report changed, the person
 * chose another currency, or the owner switched the feature on. Requests for one organization
 * close together run once, after the last, and never two at a time.
 */
export function amountConversionFunction(client: Inngest, ports: () => ConversionPorts) {
  return client.createFunction(
    {
      id: 'amount-conversion',
      name: 'Convert amounts to the reimbursement currency',
      triggers: [
        { event: CONVERSIONS_DUE },
        {
          event: FEATURE_SWITCHED,
          if: `event.data.flag == '${CONVERSION_FLAG}' && event.data.enabled == true`,
        },
      ],
      debounce: { key: 'event.data.orgId', period: '10s' },
      concurrency: { key: 'event.data.orgId', limit: 1 },
      retries: 3,
    },
    ({ event }) => convertOrganization(ports(), organizationOf(event.data)),
  );
}

/** The hourly sweep for what is still converting. A run while one is going is skipped. */
export function conversionSweepFunction(client: Inngest, ports: () => ConversionPorts) {
  return client.createFunction(
    {
      id: 'amount-conversion-sweep',
      name: 'Convert what is still converting',
      triggers: [{ cron: CONVERSION_SWEEP }],
      singleton: { mode: 'skip' },
      retries: 2,
    },
    () => sweepConversions(ports()),
  );
}
