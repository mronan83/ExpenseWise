import type { Identity } from './auth.ts';
import type { FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';

/** The switch that turns the second factor on for an organization (F-11, #8). */
export const SECOND_FACTOR_FLAG = 'security.second-factor';

/**
 * Refuses an action unless this session passed the second factor (aal2): approving someone
 * else's spend, and every admin action once the organization has switched the second factor
 * on (FR-GOV-04). A one-person organization's self-attestation never needs it.
 */
export function requireSecondFactor(
  identity: Pick<Identity, 'assuranceLevel'>,
  detail = 'Enter the code from your authenticator app, then try again.',
): void {
  if (identity.assuranceLevel === 'aal2') return;
  throw new ProblemError(403, 'second-factor-required', 'This needs your second factor', {
    code: 'second_factor_required',
    detail,
  });
}

/**
 * Every admin action (FR-GOV-04): an owner's or finance admin's change to how the organization
 * works, its people or its keys needs a session that passed the second factor while the
 * organization has it switched on. Off, nothing changes. Called after the role check, so a
 * member is still told it isn't theirs to do; a session already at aal2 never reads the switch.
 */
export async function requireAdminSecondFactor(
  features: FeatureGate,
  orgId: string,
  identity: Pick<Identity, 'assuranceLevel'>,
): Promise<void> {
  if (identity.assuranceLevel === 'aal2') return;
  if (await features.isOn(orgId, SECOND_FACTOR_FLAG)) requireSecondFactor(identity);
}

/** How an admin operation's refusal reads in the API contract. */
export const SECOND_FACTOR_REFUSAL =
  ' While the organization has the second factor switched on, a session that has not passed ' +
  'it is refused with second_factor_required (FR-GOV-04).';
