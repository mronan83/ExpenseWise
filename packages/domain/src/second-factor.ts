/**
 * The second factor at sign-in (FR-PLT-03, F-11): a code from an authenticator app, checked by
 * Supabase Auth. These are the app's own rules around it; Supabase Auth keeps the secrets and
 * checks the codes.
 */

/** Digits in an authenticator app's code: TOTP, a new code every 30 seconds (RFC 6238). */
export const SECOND_FACTOR_CODE_LENGTH = 6;

/** The most authenticator apps one person keeps: Supabase Auth's own limit on verified factors. */
export const MAX_AUTHENTICATORS = 10;

const CODE = new RegExp(`^\\d{${SECOND_FACTOR_CODE_LENGTH}}$`);

/** A code as typed or pasted, without the spaces or dash some apps show; null unless 6 digits. */
export function readSecondFactorCode(typed: string): string | null {
  const code = typed.replace(/[\s-]/g, '');
  return CODE.test(code) ? code : null;
}

/** Where a session stands, as Supabase Auth says: its level, and the level it could reach. */
export interface AssuranceLevels {
  readonly current: string | null;
  readonly next: string | null;
}

/**
 * Whether to ask for the code before anything else: someone with a verified authenticator,
 * signed in with a password alone (aal1, able to reach aal2), while their organization has the
 * second factor switched on. Off, sign-in is as it was, so the server's override stops it too.
 */
export function asksForCode(levels: AssuranceLevels, switchedOn: boolean): boolean {
  return switchedOn && levels.current === 'aal1' && levels.next === 'aal2';
}

/** What Settings › Sign-ins offers someone about authenticator apps. */
export interface AuthenticatorOffer {
  /** Whether the section shows: switched on, the owner, or someone who already has one. */
  readonly shown: boolean;
  /** Whether another can be added now. */
  readonly canAdd: boolean;
  /** The owner, adding theirs before switching the second factor on for everyone. */
  readonly beforeSwitchingOn: boolean;
  /** One alone: losing that phone would lock them out, so a second is suggested. */
  readonly suggestAnother: boolean;
}

/**
 * Adding an authenticator is offered while the organization has the second factor switched
 * on, and to its owner while it is off: switching it on needs the owner's own code, so the owner
 * adds theirs first and no one is locked out. Someone who already has one always sees theirs,
 * to remove it.
 */
export function authenticatorOffer(who: {
  readonly switchedOn: boolean;
  readonly owner: boolean;
  readonly enrolled: number;
}): AuthenticatorOffer {
  const offered = who.switchedOn || who.owner;
  return {
    shown: offered || who.enrolled > 0,
    canAdd: offered && who.enrolled < MAX_AUTHENTICATORS,
    beforeSwitchingOn: who.owner && !who.switchedOn,
    suggestAnother: who.enrolled === 1,
  };
}

/**
 * Where to go once the code is in: a path on this site, never another site or the sign-in
 * screens themselves; Home otherwise.
 */
export function afterSecondFactor(next: string | null): string {
  if (!next || !/^\/(?![/\\])[^\s]*$/.test(next) || next.startsWith('/sign-in')) return '/';
  return next;
}
