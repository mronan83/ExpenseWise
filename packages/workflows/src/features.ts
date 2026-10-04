import { orgFeatureOn, type Transaction } from '@expensewise/db';
import { parseOverrides, type FlagKey } from '@expensewise/flags';

/** Runs work inside one organization, as a workflow's database does (`checkedDatabase`). */
type InOrg = <T>(orgId: string, work: (tx: Transaction) => Promise<T>) => Promise<T>;

/**
 * Whether a feature is on for an organization, where a workflow has no request to ask: the
 * server's FLAG_OVERRIDES wins, as its kill switch, then the organization's own switch, then
 * off (ADR-0032). The same order as the API's FeatureGate.
 */
export function featureSwitch(
  inOrg: InOrg,
  overrides: string | undefined = process.env.FLAG_OVERRIDES,
): (orgId: string, flag: FlagKey) => Promise<boolean> {
  const forced = parseOverrides(overrides, (message) => console.warn(message));
  return async (orgId, flag) =>
    forced[flag] ?? (await inOrg(orgId, (tx) => orgFeatureOn(tx, orgId, flag)));
}

/**
 * Whether a feature is on for an organization, where a workflow has no API to ask: the
 * server's override (FLAG_OVERRIDES) wins, as the kill switch, then the organization's own
 * switch, then off (ADR-0032), the same order as the API's feature gate. Call inside withOrg().
 */
export async function featureOn(
  tx: Transaction,
  orgId: string,
  flag: FlagKey,
  overrides: string | undefined = process.env.FLAG_OVERRIDES,
): Promise<boolean> {
  const override = parseOverrides(overrides)[flag];
  if (override !== undefined) return override;
  return orgFeatureOn(tx, orgId, flag);
}
