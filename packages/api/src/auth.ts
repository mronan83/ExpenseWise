import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { problem } from './problem.ts';

/** Who is calling, as proven by a verified access token. Membership is resolved separately. */
export interface Identity {
  /** The identity provider's user ID (Supabase Auth `sub`). Stored as members.user_id. */
  readonly userId: string;
  readonly email: string | null;
  /** Authenticator assurance level: aal2 means the session passed multi-factor authentication. */
  readonly assuranceLevel: 'aal1' | 'aal2';
  readonly sessionId: string | null;
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

/**
 * Verifies Supabase Auth access tokens against the project's published signing keys (JWKS),
 * so this backend never holds a signing secret (ADR-0013). Only asymmetric algorithms are
 * accepted, and only tokens for signed-in users: anon and service keys are rejected.
 */
export function supabaseTokenVerifier(options: {
  /** e.g. https://abcd1234.supabase.co */
  projectUrl: string;
  /** Override the key source in tests. Defaults to the project's JWKS endpoint. */
  keys?: JWTVerifyGetKey;
}): TokenVerifier {
  const issuer = `${options.projectUrl.replace(/\/+$/, '')}/auth/v1`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'exp'],
      });
      if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') {
        throw new AuthError('invalid_token', 'The token is not a signed-in user session');
      }
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        assuranceLevel: payload.aal === 'aal2' ? 'aal2' : 'aal1',
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
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
      c.set('identity', await verifier(token));
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
