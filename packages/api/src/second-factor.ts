import type { PassedCode } from '@expensewise/db';
import { admission, type SignInStanding } from '@expensewise/domain';
import type { MiddlewareHandler } from 'hono';
import type { Identity } from './auth.ts';
import { isBeforeTheCode, markBeforeTheCode, requestIdentity, type AdmitCaller } from './caller.ts';
import type { FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import type { CallerMembership } from './workspace.ts';

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

/** The refusal of a session that skipped the code, of an email with an authenticator (#85). */
const codeBeforeAnythingElse = (identity: Pick<Identity, 'assuranceLevel'>) =>
  requireSecondFactor(
    identity,
    'Your organization asks for the code from your authenticator app before anything else. ' +
      'Enter it, then try again.',
  );

/** The refusal of an email that needs its own authenticator, naming that email (#88). */
export function authenticatorRequired(email: string | null): ProblemError {
  const which = email ?? 'The email you signed in with';
  return new ProblemError(403, 'authenticator-required', 'This email needs its own authenticator', {
    code: 'authenticator_required',
    detail:
      `${which} has no authenticator app of its own, and another email you sign in with has ` +
      'one. Your organization asks each of your emails for its own before anything else: add ' +
      'one to this email in Settings › Sign-ins and enter its code, then try again.',
    ...(email ? { email } : {}),
  });
}

/**
 * The refusal of an email that isn't let in, naming that email (#90, Q44). It is never asked
 * for a code or offered an authenticator: only an email let in, from one with the code, may add
 * one.
 */
export function signInNotLetIn(email: string | null): ProblemError {
  const which = email ?? 'The email you signed in with';
  return new ProblemError(403, 'sign-in-not-let-in', 'This email isn’t let in to sign in', {
    code: 'sign_in_not_let_in',
    detail:
      `${which} isn't let in to sign in. Once you have an authenticator app, only the emails ` +
      'you let in open ExpenseWise; receipts you send from this one are still filed. To let it ' +
      'in, sign in with the email that has your authenticator app, enter its code, and let this ' +
      'one in from Settings › Sign-ins.',
    ...(email ? { email } : {}),
  });
}

/** What the admission step needs to keep the record of who is let in (#90). */
export type RecordPassedCode = (
  caller: CallerMembership,
  actor: { readonly userId: string; readonly assuranceLevel: string },
) => Promise<PassedCode>;

/** Where a caller's sign-in stands, with what a store that can't tell leaves out read as none. */
export function standingOf(caller: CallerMembership): SignInStanding {
  const authenticator = caller.authenticator === true;
  return {
    authenticator,
    personAuthenticator: authenticator || caller.personAuthenticator === true,
    letIn: caller.letIn ?? 'no',
    personLetIn: caller.personLetIn ?? 'none',
  };
}

/**
 * How far a session gets (#85, #88, #90, ADR-0044), while its organization has the second factor
 * switched on, by where its email stands (`admission`): an email that isn't let in is refused
 * with `sign_in_not_let_in`; one let in with no authenticator of its own, while another let in
 * has one, with `authenticator_required`; one with an authenticator, at aal1, with
 * `second_factor_required`. At aal2, the first of a person's emails to pass its code is let in,
 * and one waiting stays let in, each recorded before the request goes on; if another email
 * became the first just before, it is refused instead. Someone with no authenticator that counts
 * isn't asked, and the switch is read only when something would be refused or recorded.
 */
export async function admitSignIn(
  features: FeatureGate,
  caller: CallerMembership,
  identity: Pick<Identity, 'userId' | 'email' | 'assuranceLevel'>,
  recordPassedCode?: RecordPassedCode,
): Promise<void> {
  const step = admission(standingOf(caller), identity.assuranceLevel);
  if (step === 'open') return;
  if (!(await features.isOn(caller.orgId, SECOND_FACTOR_FLAG))) return;
  switch (step) {
    case 'not_let_in':
      throw signInNotLetIn(identity.email);
    case 'own_authenticator':
      throw authenticatorRequired(identity.email);
    case 'code':
      codeBeforeAnythingElse(identity);
      return;
    case 'let_in_first':
    case 'passed': {
      if (!recordPassedCode) return;
      const done = await recordPassedCode(caller, identity);
      if (done === 'not_let_in') throw signInNotLetIn(identity.email);
      return;
    }
  }
}

/**
 * The check, run once as every request resolves its caller (`recordingCaller`), before anything
 * of the organization is read or changed: no route can forget it (`admitSignIn`). A request the
 * code screen, or the screens that say an email needs its own authenticator or isn't let in,
 * need (`beforeTheCode`) is let through, and so is a lookup that isn't the token's own person.
 */
export function secondFactorEverywhere(
  features: FeatureGate,
  recordPassedCode?: RecordPassedCode,
): AdmitCaller {
  return async (caller, userId) => {
    const identity = requestIdentity();
    if (!identity || identity.userId !== userId || isBeforeTheCode()) return;
    await admitSignIn(features, caller, identity, recordPassedCode);
  };
}

/**
 * Marks a request the code screen, or the check that sends someone to it, needs to work, so a
 * session that hasn't passed the code may still make it: only for `method`.
 */
export function beforeTheCode(method: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === method.toUpperCase()) markBeforeTheCode();
    await next();
  };
}

/**
 * Linking another sign-in (FR-PLT-04) is how an account is taken over: someone with an
 * authenticator links one only from a session that passed the code, whether or not their
 * organization has the second factor switched on (#85).
 */
export function requireCodeToLink(
  caller: Pick<CallerMembership, 'authenticator'>,
  identity: Pick<Identity, 'assuranceLevel'>,
): void {
  if (caller.authenticator !== true) return;
  requireSecondFactor(
    identity,
    'Linking another sign-in needs the code from your authenticator app, so a password alone ' +
      'can’t add a way in. Enter it, then link it again.',
  );
}

/** How an admin operation's refusal reads in the API contract. */
export const SECOND_FACTOR_REFUSAL =
  ' While the organization has the second factor switched on, a session that has not passed ' +
  'it is refused with second_factor_required (FR-GOV-04).';
