import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { recordIdentity } from './caller.ts';
import { problem } from './problem.ts';

/** Who is calling, as proven by a verified access token. Membership is resolved separately. */
export interface Identity {
  /** The identity provider's user ID (Supabase Auth `sub`). Stored as members.user_id. */
  readonly userId: string;
  readonly email: string | null;
  /** Authenticator assurance level: aal2 means the session passed multi-factor authentication. */
  readonly assuranceLevel: 'aal1' | 'aal2';
  readonly sessionId: string | null;
  /** When the token was issued (`iat`), so an action can ask for a recent sign-in. */
  readonly issuedAt: Date | null;
}

export type TokenVerifier = (token: string) => Promise<Identity>;

export class AuthError extends Error {
  constructor(
    readonly code: 'invalid_token' | 'expired_token',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type AuthVariables = { identity: Identity };

// A loop, not /\/+$/: that pattern backtracks quadratically on a long run of '/'.
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * Verifies Supabase Auth access tokens against the project's published signing keys (JWKS),
 * so this backend never holds a signing secret (ADR-0013). Only asymmetric algorithms are
 * accepted, and only tokens for signed-in users: anon keys, service keys and anonymous
 * sign-ins are rejected. A signed-out token stays valid until it expires (about an hour),
 * so sensitive actions should also check that its session_id still exists.
 */
export function supabaseTokenVerifier(options: {
  /** e.g. https://abcd1234.supabase.co */
  projectUrl: string;
  /** Override the key source in tests. Defaults to the project's JWKS endpoint. */
  keys?: JWTVerifyGetKey;
}): TokenVerifier {
  const issuer = `${withoutTrailingSlashes(options.projectUrl)}/auth/v1`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'exp'],
      });
      // Supabase anonymous sign-ins also carry role "authenticated"; is_anonymous tells them apart.
      if (
        payload.role !== 'authenticated' ||
        payload.is_anonymous === true ||
        typeof payload.sub !== 'string'
      ) {
        throw new AuthError('invalid_token', 'The token is not a signed-in user session');
      }
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        assuranceLevel: payload.aal === 'aal2' ? 'aal2' : 'aal1',
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
        issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : null,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof errors.JWTExpired) {
        throw new AuthError('expired_token', 'The access token has expired');
      }
      throw new AuthError('invalid_token', 'The access token is not valid');
    }
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Requires a verified bearer token and exposes the caller as `c.var.identity`. */
export function requireIdentity(
  verifier: TokenVerifier | undefined,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (!verifier) {
      return problem(c, 503, 'auth-not-configured', 'Sign-in is not configured on this server', {
        code: 'auth_not_configured',
      });
    }
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) {
      return problem(
        c,
        401,
        'unauthenticated',
        'Sign in required',
        { code: 'missing_token' },
        { 'WWW-Authenticate': 'Bearer realm="expensewise"' },
      );
    }
    try {
      const identity = await verifier(token);
      c.set('identity', identity);
      // For the second factor's check as the request resolves its caller (#85).
      recordIdentity(identity);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return problem(
        c,
        401,
        'unauthenticated',
        'Sign in required',
        { code: error.code, detail: error.message },
        { 'WWW-Authenticate': `Bearer realm="expensewise", error="invalid_token"` },
      );
    }
    await next();
  };
}
