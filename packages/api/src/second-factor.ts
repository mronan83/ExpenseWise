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

/**
 * Everything, for someone with an authenticator (#85, Q41): while their organization has the
 * second factor switched on, a session of a person whose sign-in has a verified second factor
 * and hasn't passed it is refused on every request. Someone with none isn't asked: their
 * session can't pass a code they don't have, and admin actions still ask them to add one. The
 * switch is read only for an enrolled person's aal1 session.
 */
export async function requireCodeOfTheEnrolled(
  features: FeatureGate,
  caller: Pick<CallerMembership, 'orgId' | 'authenticator'>,
  identity: Pick<Identity, 'assuranceLevel'>,
): Promise<void> {
  if (identity.assuranceLevel === 'aal2' || caller.authenticator !== true) return;
  if (await features.isOn(caller.orgId, SECOND_FACTOR_FLAG)) {
    requireSecondFactor(
      identity,
      'Your organization asks for the code from your authenticator app before anything else. ' +
        'Enter it, then try again.',
    );
  }
}

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
 * A person's other emails (#88, Q43): while their organization has the second factor switched
 * on, a session of an email with no authenticator of its own, of a person who has one on
 * another of their emails, is refused on every request, whatever its session says, until that
 * email adds its own and passes it. It has no code to enter yet, so it is told which email needs
 * one rather than asked for a code. Someone with none on any email isn't asked. The switch is
 * read only for an email held this way.
 */
export async function requireOwnAuthenticator(
  features: FeatureGate,
  caller: Pick<CallerMembership, 'orgId' | 'authenticator' | 'personAuthenticator'>,
  identity: Pick<Identity, 'email'>,
): Promise<void> {
  if (caller.authenticator === true || caller.personAuthenticator !== true) return;
  if (await features.isOn(caller.orgId, SECOND_FACTOR_FLAG)) {
    throw authenticatorRequired(identity.email);
  }
}

/**
 * The check, run once as every request resolves its caller (`recordingCaller`), before anything
 * of the organization is read or changed: no route can forget it. An email with no authenticator
 * of a person who has one is held until it adds its own (#88); an email with one, until its
 * session passes the code (#85); each reads the switch only in its own case, so at most once. A
 * request the code screen, or adding an authenticator, needs (`beforeTheCode`) is let through,
 * and so is a lookup that isn't the token's own person.
 */
export function secondFactorEverywhere(features: FeatureGate): AdmitCaller {
  return async (caller, userId) => {
    const identity = requestIdentity();
    if (!identity || identity.userId !== userId || isBeforeTheCode()) return;
    await requireOwnAuthenticator(features, caller, identity);
    await requireCodeOfTheEnrolled(features, caller, identity);
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
