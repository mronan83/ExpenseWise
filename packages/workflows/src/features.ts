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
