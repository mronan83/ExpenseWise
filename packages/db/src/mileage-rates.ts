import {
  IRS_BUSINESS_RATES,
  IRS_BUSINESS_SOURCE,
  mileageRate,
  ORGANIZATION_RATE_SOURCE,
  OWN_RATE_PLACES,
  ownMileageRate,
  parseDecimal,
  toScale,
  type MileagePolicy,
  type MileageRate,
  type OwnMileageRate,
  type OwnRateProblem,
} from '@expensewise/domain';
import { and, desc, eq } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import type { Transaction } from './client.ts';
import { members, organizations, orgMileageRates } from './schema.ts';

/** One change an organization made to what drives are paid at, with who made it and when. */
export interface MileageRateChangeRecord extends OwnMileageRate {
  readonly id: string;
  /** The member who set it last, by name. */
  readonly setBy: string;
  readonly setAt: Date;
}

interface RateRow {
  readonly effectiveFrom: string;
  readonly perMile: string | null;
  readonly currency: string | null;
}

/** Its own rate a mile, or null for the IRS rate again. */
const rateOf = (row: RateRow): MileageRate | null =>
  row.perMile !== null && row.currency !== null
    ? mileageRate({
        currency: row.currency,
        perUnit: row.perMile,
        unit: 'mi',
        effectiveFrom: row.effectiveFrom,
        source: ORGANIZATION_RATE_SOURCE,
      })
    : null;

const changeOf = (row: RateRow): OwnMileageRate => ({
  effectiveFrom: row.effectiveFrom,
  rate: rateOf(row),
});

/**
 * The changes the organization made to its rate a mile, the latest day first, each with who
 * set it (Q28). Call inside withOrg().
 */
export async function listMileageRateChanges(tx: Transaction): Promise<MileageRateChangeRecord[]> {
  const rows = await tx
    .select({
      id: orgMileageRates.id,
      effectiveFrom: orgMileageRates.effectiveFrom,
      perMile: orgMileageRates.perMile,
      currency: orgMileageRates.currency,
      setBy: members.displayName,
      setAt: orgMileageRates.updatedAt,
    })
    .from(orgMileageRates)
    .innerJoin(
      members,
      and(eq(members.orgId, orgMileageRates.orgId), eq(members.id, orgMileageRates.setByMemberId)),
    )
    .orderBy(desc(orgMileageRates.effectiveFrom));
  return rows.map((r) => ({ id: r.id, ...changeOf(r), setBy: r.setBy, setAt: r.setAt }));
}

/**
 * What the organization pays drives at (Q28): its own changes over the IRS business rates.
 * Every member reads it, since pricing their drives needs it. Call inside withOrg().
 */
export async function mileagePolicy(tx: Transaction): Promise<MileagePolicy> {
  const rows = await tx
    .select({
      effectiveFrom: orgMileageRates.effectiveFrom,
      perMile: orgMileageRates.perMile,
      currency: orgMileageRates.currency,
    })
    .from(orgMileageRates);
  return { own: rows.map(changeOf), irs: IRS_BUSINESS_RATES };
}

export type SetMileageRateResult =
  | { readonly status: 'set'; readonly id: string }
  /** That day already had it. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged'; readonly id: string }
  | { readonly status: 'invalid'; readonly problem: OwnRateProblem }
  | { readonly status: 'missing' };

/** Two rates a mile alike, whatever trailing zeros they carry. */
const sameRate = (a: string | null, b: string | null) =>
  a === null || b === null
    ? a === b
    : toScale(parseDecimal(a), OWN_RATE_PLACES, 'exact') ===
      toScale(parseDecimal(b), OWN_RATE_PLACES, 'exact');

/** What the audit trail keeps of a day's change. */
const changePayload = (row: RateRow) => ({
  source: row.perMile === null ? IRS_BUSINESS_SOURCE : ORGANIZATION_RATE_SOURCE,
  perMile: row.perMile,
  currency: row.currency,
});

/**
 * Sets what drives are paid at from a day (Q28, #77): the organization's own rate a mile, in
 * its home currency, or with `perMile` null the IRS business rate again. An owner or finance
 * admin does this; the API checks the role. One change per day: setting a day again replaces
 * its change. Each change is in the audit trail, and setting what a day already has records
 * nothing. Drives already logged keep the rate they were paid at (NFR-DAT-04). Call inside
 * withOrg().
 */
export async function setMileageRate(
  tx: Transaction,
  orgId: string,
  input: { readonly effectiveFrom: string; readonly perMile: string | null },
  actor: { readonly userId: string; readonly memberId: string },
): Promise<SetMileageRateResult> {
  await lockOrgWrites(tx, orgId);
  const [org] = await tx
    .select({ homeCurrency: organizations.homeCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return { status: 'missing' };
  const checked = ownMileageRate(input, org.homeCurrency);
  if (!checked.ok) return { status: 'invalid', problem: checked.error };
  const { effectiveFrom, rate } = checked.value;
  const next: RateRow = {
    effectiveFrom,
    perMile: rate?.perUnit ?? null,
    currency: rate?.currency ?? null,
  };

  const [was] = await tx
    .select({
      id: orgMileageRates.id,
      effectiveFrom: orgMileageRates.effectiveFrom,
      perMile: orgMileageRates.perMile,
      currency: orgMileageRates.currency,
    })
    .from(orgMileageRates)
    .where(eq(orgMileageRates.effectiveFrom, effectiveFrom))
    .for('update');
  if (was && sameRate(was.perMile, next.perMile) && was.currency === next.currency) {
    return { status: 'unchanged', id: was.id };
  }
  const now = new Date();
  const values = { perMile: next.perMile, currency: next.currency, setByMemberId: actor.memberId };
  const [saved] = was
    ? await tx
        .update(orgMileageRates)
        .set({ ...values, updatedAt: now })
        .where(eq(orgMileageRates.id, was.id))
        .returning({ id: orgMileageRates.id })
    : await tx
        .insert(orgMileageRates)
        .values({ orgId, effectiveFrom, ...values })
        .returning({ id: orgMileageRates.id });
  if (!saved) throw new Error('The mileage rate was not saved');
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actor.userId },
    entityType: 'mileage_rate',
    entityId: saved.id,
    action: 'mileage_rate.set',
    payload: {
      effectiveFrom,
      ...changePayload(next),
      replaced: was ? changePayload(was) : null,
    },
  });
  return { status: 'set', id: saved.id };
}
