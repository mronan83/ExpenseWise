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

/*
 * Only an email a person lets in signs in, once they have an authenticator (#90, Q44,
 * ADR-0044). Each email someone signs in with is its own sign-in, with its own password and its
 * own authenticators. Only the email they first signed in with is let in on its own, once it
 * passes its code (#91, Q45); another of theirs opens nothing until they let it in from one that
 * passed its code, and it adds its own authenticator and passes that. Email-in never asks: an
 * email from any of their addresses is still filed.
 */

/**
 * Hours an email someone lets in has to add its own authenticator app and pass its code before
 * letting it in lapses (#90), counted by the database's clock from when it was let in. Once it
 * passes, it stays let in until withdrawn.
 */
export const LET_IN_HOURS = 24;

/**
 * Whether one of a person's emails is let in: not; let in from another of theirs and waiting
 * to pass its own code, until the time runs out; or let in.
 */
export type LetIn = 'no' | 'waiting' | 'yes';

/**
 * The emails a person has let in: none yet; some, none of which has an authenticator now; or
 * at least one that has.
 */
export type PersonLetIn = 'none' | 'without_authenticator' | 'with_authenticator';

/** What decides how far a session of one of a person's emails gets (#85, #88, #90, #91). */
export interface SignInStanding {
  /** This email has a verified authenticator of its own. */
  readonly authenticator: boolean;
  /** An email of the person's has one, this one or another. */
  readonly personAuthenticator: boolean;
  readonly letIn: LetIn;
  readonly personLetIn: PersonLetIn;
  /**
   * This is the email the person first signed in with: the sign-in their membership was made
   * with, on their first sign-in or by accepting their invite (#91, Q45). The only one let in
   * on its own, while none of theirs is.
   */
  readonly firstSignIn: boolean;
}

/** What a session meets while its organization has the second factor switched on. */
export type Admission =
  /** Nothing more is asked. */
  | 'open'
  /** The code of its own authenticator, before anything else (#85). */
  | 'code'
  /**
   * The email the person first signed in with passed its own code while none of theirs is let
   * in: it is, the first (#91).
   */
  | 'let_in_first'
  /** Let in and waiting, it passed its own code: it stays let in. */
  | 'passed'
  /**
   * Let in, with no authenticator of its own, while another let-in email has one (#88); or the
   * email the person first signed in with, with none of its own, while none of theirs is let in
   * and another has one: it may add its own, and is then let in first (#91).
   */
  | 'own_authenticator'
  /** Not let in, while the person has an authenticator that counts. */
  | 'not_let_in';

/**
 * Whether a person has an authenticator that counts: one on an email they let in, or, before
 * any is let in, on any of their emails. Once one is let in, an authenticator on an email that
 * isn't counts for nothing, so its holder can't make a way in of their own. When every email
 * let in has lost its authenticator, by its person or by the owner for a lost phone, none
 * counts, and nothing more is asked of any of their emails until one let in adds one again.
 */
export function hasAuthenticatorThatCounts(standing: SignInStanding): boolean {
  return standing.personLetIn === 'none'
    ? standing.personAuthenticator
    : standing.personLetIn === 'with_authenticator';
}

/**
 * How far a session of one of a person's emails gets while their organization has the second
 * factor switched on (#85, #88, #90, #91), from where the email stands and whether the session
 * passed a code (aal2). Someone with no authenticator that counts isn't asked. Otherwise an
 * email that isn't let in is refused whatever its session says, its own authenticators
 * included; the one exception, while none of the person's emails is let in, is the email they
 * first signed in with, which is asked for its own code, or to add its own authenticator if it
 * has none, and is let in once it passes it. Any other of theirs waits to be let in from it,
 * even one that passes a code of its own first. An email let in needs its own authenticator,
 * then its code; one waiting stays let in once it passes it. A session's aal2 counts only with
 * an authenticator of the email's own now: a token can read aal2 for a while after its last is
 * removed.
 */
export function admission(standing: SignInStanding, assuranceLevel: string): Admission {
  if (!hasAuthenticatorThatCounts(standing)) return 'open';
  const passedCode = assuranceLevel === 'aal2';
  if (standing.letIn === 'no') {
    if (standing.personLetIn === 'none' && standing.firstSignIn) {
      if (!standing.authenticator) return 'own_authenticator';
      return passedCode ? 'let_in_first' : 'code';
    }
    return 'not_let_in';
  }
  if (!standing.authenticator) return 'own_authenticator';
  if (!passedCode) return 'code';
  return standing.letIn === 'waiting' ? 'passed' : 'open';
}

/**
 * Whether a session may let another of the person's emails in, or withdraw one: its email is
 * let in, has an authenticator of its own and passed its code (aal2). A password alone, or an
 * email not let in, never changes who is let in.
 */
export function mayLetIn(
  standing: Pick<SignInStanding, 'authenticator' | 'letIn'>,
  assuranceLevel: string,
): boolean {
  return standing.letIn === 'yes' && standing.authenticator && assuranceLevel === 'aal2';
}
