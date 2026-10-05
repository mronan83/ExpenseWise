import {
  asksForCode,
  readSecondFactorCode,
  SECOND_FACTOR_CODE_LENGTH,
  type AssuranceLevels,
} from '@expensewise/domain';
import type { AuthError } from '@supabase/supabase-js';
import { loadFeatures } from './features';
import { stepUp } from './step-up';
import { supabase } from './supabase';

/*
 * The second factor at sign-in (F-11), through Supabase Auth's MFA API in the browser. This is
 * authentication only (ADR-0013): Supabase keeps each authenticator's secret and checks each
 * code; nothing here reads or writes the organization's data.
 */

/** The switch for the whole organization (Settings › Features). */
export const SECOND_FACTOR_FLAG = 'security.second-factor';

/** An authenticator app someone added, as Settings › Sign-ins lists it. */
export interface Authenticator {
  readonly id: string;
  readonly name: string;
  readonly addedAt: string;
}

/** A new authenticator, waiting for its first code: the QR code to scan, or the key to type. */
export interface Enrollment {
  readonly factorId: string;
  /** An SVG image, as a data URL. */
  readonly qrCode: string;
  readonly secret: string;
}

/** Something Supabase Auth refused, in words to show. */
export class SecondFactorError extends Error {
  override name = 'SecondFactorError';
}

const auth = () => {
  const client = supabase()?.auth;
  if (!client) throw new SecondFactorError("Sign-in isn't configured on this deployment.");
  return client;
};

const wording = (error: AuthError): string => {
  switch (error.code) {
    case 'mfa_verification_failed':
    case 'mfa_challenge_expired':
      return 'That code didn’t work. Codes change every 30 seconds: enter the one showing now.';
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a few minutes, then try again.';
    case 'mfa_factor_name_conflict':
      return 'You already have an authenticator with that name. Give this one another.';
    case 'too_many_enrolled_mfa_factors':
      return 'You have as many authenticators as you can. Remove one first.';
    default:
      return error.message;
  }
};

/** Supabase Auth wants a session that passed the code for this. */
const wantsCode = (error: AuthError) => error.code === 'insufficient_aal';

/**
 * Where the session stands. Null when it can't be told: signed out, or a token Supabase Auth
 * didn't issue; the server still checks what matters.
 */
export async function assuranceLevels(): Promise<AssuranceLevels | null> {
  const client = supabase()?.auth;
  if (!client) return null;
  try {
    const { data, error } = await client.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data.currentLevel) return null;
    return { current: data.currentLevel, next: data.nextLevel };
  } catch {
    return null;
  }
}

/** Whether the signed-in person's organization has the second factor switched on. */
export async function secondFactorOn(fresh = false): Promise<boolean> {
  const { features } = await loadFeatures(fresh);
  return features.some((f) => f.key === SECOND_FACTOR_FLAG && f.enabled);
}

/** Whether to ask for the code before anything else (FR-PLT-03). */
export async function codeNeeded(fresh = false): Promise<boolean> {
  const levels = await assuranceLevels();
  // The session alone says no for nearly everyone; only then is the switch read.
  if (!levels || !asksForCode(levels, true)) return false;
  return asksForCode(levels, await secondFactorOn(fresh));
}

/** The person's authenticator apps, oldest first. */
export async function authenticators(): Promise<Authenticator[]> {
  const { data, error } = await auth().mfa.listFactors();
  if (error) throw new SecondFactorError(wording(error));
  return data.totp
    .map((f) => ({ id: f.id, name: f.friendly_name || 'Authenticator app', addedAt: f.created_at }))
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

/** Checks a code with Supabase Auth; this session then counts as having passed it (aal2). */
export async function passCode(factorId: string, typed: string): Promise<void> {
  const code = readSecondFactorCode(typed);
  if (!code) {
    throw new SecondFactorError(
      `Enter the ${SECOND_FACTOR_CODE_LENGTH}-digit code your authenticator app shows.`,
    );
  }
  const { error } = await auth().mfa.challengeAndVerify({ factorId, code });
  if (error) throw new SecondFactorError(wording(error));
}

/**
 * Runs a change Supabase Auth makes only for a session that passed the code: asks for it,
 * where the app shows its prompt, when Supabase says so, then tries once more.
 */
async function withCode<T>(change: () => Promise<{ data: T | null; error: AuthError | null }>) {
  let { data, error } = await change();
  if (error && wantsCode(error) && (await stepUp())) ({ data, error } = await change());
  if (error) {
    throw new SecondFactorError(
      wantsCode(error) ? 'Enter the code from your authenticator app first.' : wording(error),
    );
  }
  return data as T;
}

/**
 * Starts adding an authenticator app named `name`. A half-finished one is cleared first:
 * Supabase keeps it unverified, and would refuse its name again.
 */
export async function startEnrolling(name: string): Promise<Enrollment> {
  const client = auth();
  const { data: listed } = await client.mfa.listFactors();
  for (const f of listed?.all ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') {
      await client.mfa.unenroll({ factorId: f.id });
    }
  }
  const enrolled = await withCode(() =>
    client.mfa.enroll({ factorType: 'totp', friendlyName: name, issuer: 'ExpenseWise' }),
  );
  return { factorId: enrolled.id, qrCode: enrolled.totp.qr_code, secret: enrolled.totp.secret };
}

/** Stops adding one: the unverified authenticator goes. */
export async function cancelEnrolling(factorId: string): Promise<void> {
  await auth().mfa.unenroll({ factorId });
}

/** Removes an authenticator app, after the code when Supabase asks for it. */
export async function removeAuthenticator(factorId: string): Promise<void> {
  await withCode(() => auth().mfa.unenroll({ factorId }));
}
