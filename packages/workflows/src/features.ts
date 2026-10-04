import { orgFeatureOn, type Transaction } from '@expensewise/db';
import { parseOverrides, type FlagKey } from '@expensewise/flags';

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
