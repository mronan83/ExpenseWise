import type { Identity } from './auth.ts';
import { ProblemError } from './problem.ts';

/**
 * Refuses an action unless this session passed the second factor (aal2): approving someone
 * else's spend, and every admin action once the organization has switched the second factor
 * on (FR-GOV-04). A one-person organization's self-attestation never needs it.
 */
export function requireSecondFactor(identity: Pick<Identity, 'assuranceLevel'>): void {
  if (identity.assuranceLevel === 'aal2') return;
  throw new ProblemError(403, 'second-factor-required', 'This needs your second factor', {
    code: 'second_factor_required',
    detail: 'Enter the code from your authenticator app, then try again.',
  });
}
