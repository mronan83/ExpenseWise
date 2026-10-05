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

/**
 * The refusal of an email that needs its own authenticator, naming that email (#88). While none
 * of the person's emails is let in (`noneLetIn`), it is the one they first signed in with, which
 * is let in once it adds its own and passes its code (#91); the problem says so, so the app can.
 */
export function authenticatorRequired(email: string | null, noneLetIn = false): ProblemError {
  const which = email ?? 'The email you signed in with';
  return new ProblemError(403, 'authenticator-required', 'This email needs its own authenticator', {
    code: 'authenticator_required',
    detail:
      `${which} has no authenticator app of its own, and another email you sign in with has ` +
      'one. Your organization asks each of your emails for its own before anything else: add ' +
      'one to this email in Settings › Sign-ins and enter its code, then try again.' +
      (noneLetIn
        ? ' It is the email you first signed in with, so it is let in then, and you let your ' +
          'others in from it.'
        : ''),
    ...(email ? { email } : {}),
    ...(noneLetIn ? { noneLetIn: true } : {}),
  });
}

/**
 * The refusal of an email that isn't let in, naming that email (#90, Q44). It is never asked
 * for a code or offered an authenticator: only an email let in, from one with the code, may add
 * one. While none of the person's emails is let in (`noneLetIn`), only the one they first signed
 * in with is let in on its own, and this isn't it (#91, Q45): the problem says so, so the app can
 * say to let it in from that one.
 */
export function signInNotLetIn(email: string | null, noneLetIn = false): ProblemError {
  const which = email ?? 'The email you signed in with';
  const how = noneLetIn
    ? 'None of your emails is let in yet, and only the one you first signed in with is let in ' +
      'on its own. To let this one in, sign in with the email you first signed in with, add an ' +
      'authenticator app to it if it has none, enter its code, and let this one in from ' +
      'Settings › Sign-ins there.'
    : 'To let it in, sign in with the email that has your authenticator app, enter its code, and ' +
      'let this one in from Settings › Sign-ins.';
  return new ProblemError(403, 'sign-in-not-let-in', 'This email isn’t let in to sign in', {
    code: 'sign_in_not_let_in',
    detail:
      `${which} isn't let in to sign in. Once you have an authenticator app, only the emails ` +
      `you let in open ExpenseWise; receipts you send from this one are still filed. ${how}`,
    ...(email ? { email } : {}),
    ...(noneLetIn ? { noneLetIn: true } : {}),
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
    firstSignIn: caller.firstSignIn === true,
  };
}

/**
 * How far a session gets (#85, #88, #90, #91, ADR-0044), while its organization has the second
 * factor switched on, by where its email stands (`admission`): an email that isn't let in is
 * refused with `sign_in_not_let_in`; one let in with no authenticator of its own, while another
 * let in has one, or the email the person first signed in with with none, while none of theirs
 * is let in, with `authenticator_required`; one with an authenticator, at aal1, with
 * `second_factor_required`. While none is let in, each refusal carries `noneLetIn`. At aal2, the
 * email the person first signed in with is let in, while none of theirs is, and one waiting
 * stays let in, each recorded before the request goes on; if the database finds otherwise just
 * then, it is refused instead. Someone with no authenticator that counts isn't asked, and the
 * switch is read only when something would be refused or recorded.
 */
export async function admitSignIn(
  features: FeatureGate,
  caller: CallerMembership,
  identity: Pick<Identity, 'userId' | 'email' | 'assuranceLevel'>,
  recordPassedCode?: RecordPassedCode,
): Promise<void> {
  const standing = standingOf(caller);
  const step = admission(standing, identity.assuranceLevel);
  if (step === 'open') return;
  if (!(await features.isOn(caller.orgId, SECOND_FACTOR_FLAG))) return;
  const noneLetIn = standing.personLetIn === 'none';
  switch (step) {
    case 'not_let_in':
      throw signInNotLetIn(identity.email, noneLetIn);
    case 'own_authenticator':
      throw authenticatorRequired(identity.email, noneLetIn);
    case 'code':
      codeBeforeAnythingElse(identity);
      return;
    case 'let_in_first':
    case 'passed': {
      if (!recordPassedCode) return;
      const done = await recordPassedCode(caller, identity);
      if (done === 'not_let_in') throw signInNotLetIn(identity.email, noneLetIn);
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
