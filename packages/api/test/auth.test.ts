import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { supabaseTokenVerifier, type TokenVerifier } from '../src/auth.ts';

const PROJECT = 'https://test-project.supabase.co';
const USER = '6f1d2c3e-8a4b-4f5e-9c7d-0a1b2c3d4e5f';

let verifyToken: TokenVerifier;
let sign: (
  claims?: JWTPayload,
  opts?: { expiresIn?: string; issuer?: string; audience?: string },
) => Promise<string>;
let signWithStrangerKey: () => Promise<string>;

beforeAll(async () => {
  const project = await generateKeyPair('ES256');
  const stranger = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(project.publicKey)), kid: 'project-key', alg: 'ES256' };
  verifyToken = supabaseTokenVerifier({
    projectUrl: PROJECT,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });

  const build = (
    claims: JWTPayload,
    opts: { expiresIn?: string; issuer?: string; audience?: string },
  ) =>
    new SignJWT({
      role: 'authenticated',
      aal: 'aal1',
      email: 'alex@example.com',
      session_id: 's-1',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'project-key' })
      .setSubject(USER)
      .setIssuer(opts.issuer ?? `${PROJECT}/auth/v1`)
      .setAudience(opts.audience ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m');
  sign = (claims = {}, opts = {}) => build(claims, opts).sign(project.privateKey);
  signWithStrangerKey = () => build({}, {}).sign(stranger.privateKey);
});

const call = (token?: string, verifier: TokenVerifier | 'unconfigured' = verifyToken) =>
  createApi({
    version: 'test',
    verifyToken: verifier === 'unconfigured' ? undefined : verifier,
  }).request('/v1/me', {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

describe('GET /v1/me', () => {
  it('returns the identity proven by a valid token', async () => {
    const res = await call(await sign({ aal: 'aal2' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER,
      email: 'alex@example.com',
      assuranceLevel: 'aal2',
      sessionId: 's-1',
    });
  });

  it('asks for a token when none is sent', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="expensewise"');
    expect(await res.json()).toMatchObject({ code: 'missing_token' });
  });

  it.each([
    ['a token signed by another key', () => signWithStrangerKey()],
    [
      'a token from another project',
      () => sign({}, { issuer: 'https://other.supabase.co/auth/v1' }),
    ],
    ['a token for another audience', () => sign({}, { audience: 'service' })],
    ['an anonymous-role token', () => sign({ role: 'anon' })],
    ['a service-role token', () => sign({ role: 'service_role' })],
    ['an anonymous sign-in', () => sign({ is_anonymous: true })],
    ['garbage', () => Promise.resolve('not.a.jwt')],
  ])('rejects %s', async (_, makeToken) => {
    const res = await call(await makeToken());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(await res.json()).toMatchObject({ code: 'invalid_token' });
  });

  it('rejects shared-secret (HS256) tokens: this backend holds no signing secret', async () => {
    const hs256 = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setIssuer(`${PROJECT}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-leaked-legacy-jwt-secret-of-32-bytes!'));
    expect((await call(hs256)).status).toBe(401);
  });

  it('distinguishes an expired token', async () => {
    const res = await call(await sign({}, { expiresIn: '-1m' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'expired_token' });
  });

  it('answers 503 when sign-in is not configured', async () => {
    const res = await call(await sign(), 'unconfigured');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'auth_not_configured' });
  });

  it('documents bearer auth in the contract', async () => {
    const doc = (await (await createApi({ version: 't' }).request('/v1/openapi.json')).json()) as {
      components: { securitySchemes: Record<string, { scheme: string }> };
      paths: Record<string, { get: { security?: unknown[] } }>;
    };
    expect(doc.components.securitySchemes.bearerAuth?.scheme).toBe('bearer');
    expect(doc.paths['/v1/me']?.get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/v1/health']?.get.security).toBeUndefined();
  });
});
