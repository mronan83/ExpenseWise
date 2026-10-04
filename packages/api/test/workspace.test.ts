import type {
  AiProvider,
  LinkResult,
  Membership,
  OrgFeature,
  SignIn,
  StoredProviderKey,
} from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import type { ProviderKeyVerifier, ProviderVerdict } from '../src/ai-providers.ts';
import { createApi } from '../src/app.ts';
import { AuthError, type Identity } from '../src/auth.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-02T12:00:00.000Z');

const OTHER_ORG = '0192f7a0-0000-7000-8000-0000000000a2';
const SIGN_IN = '0192f7a0-0000-7000-8000-0000000000c1';

const identities: Record<string, Identity> = {
  owner: {
    userId: 'u-owner',
    email: 'owner@example.com',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: NOW,
  },
  member: {
    userId: 'u-member',
    email: 'm@example.com',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: NOW,
  },
  stranger: {
    userId: 'u-new',
    email: 'new@example.com',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: NOW,
  },
  noemail: { userId: 'u-x', email: null, assuranceLevel: 'aal1', sessionId: 's', issuedAt: NOW },
  work: {
    userId: 'u-work',
    email: 'o@work.example',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: NOW,
  },
  stale: {
    userId: 'u-stale',
    email: 'old@example.com',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: new Date(NOW.getTime() - 11 * 60 * 1000),
  },
  busy: {
    userId: 'u-busy',
    email: 'busy@example.com',
    assuranceLevel: 'aal1',
    sessionId: 's',
    issuedAt: NOW,
  },
};

/** An in-memory store with one organization: an owner and a plain member. */
function fakeStore() {
  const memberships: Record<string, Membership> = {
    'u-owner': { orgId: ORG, memberId: MEMBER, role: 'owner' },
    'u-member': { orgId: ORG, memberId: MEMBER, role: 'member' },
  };
  const keys = new Map<AiProvider, StoredProviderKey>();
  const switched = new Map<string, OrgFeature>();
  const audit: string[] = [];
  const signIns: (SignIn & { memberId: string })[] = [
    {
      id: SIGN_IN,
      userId: 'u-owner',
      email: 'owner@example.com',
      createdAt: NOW,
      memberId: MEMBER,
    },
  ];
  // u-busy has an organization of its own with work in it.
  memberships['u-busy'] = { orgId: OTHER_ORG, memberId: OTHER_ORG, role: 'owner' };
  const store: WorkspaceStore = {
    ensureOrganization: ({ userId }) => {
      const existing = memberships[userId];
      const membership = existing ?? { orgId: ORG, memberId: MEMBER, role: 'owner' as const };
      memberships[userId] = membership;
      return Promise.resolve({
        membership,
        organization: { id: ORG, name: "new's organization", homeCurrency: 'USD' },
        created: !existing,
      });
    },
    findMembership: (userId) => Promise.resolve(memberships[userId]),
    listKeys: () => Promise.resolve([...keys.values()]),
    getKey: (_org, provider) => Promise.resolve(keys.get(provider)),
    saveKey: (_org, key) => {
      const saved: StoredProviderKey = { ...key, updatedAt: NOW };
      keys.set(key.provider, saved);
      audit.push(`saved:${key.provider}:${key.keyHint}`);
      return Promise.resolve(saved);
    },
    markVerified: (_org, provider, at) => {
      const k = keys.get(provider);
      if (k) keys.set(provider, { ...k, verifiedAt: at });
      audit.push(`verified:${provider}`);
      return Promise.resolve();
    },
    deleteKey: (_org, provider) => {
      const had = keys.delete(provider);
      if (had) audit.push(`removed:${provider}`);
      return Promise.resolve(had);
    },
    listSignIns: (member) =>
      Promise.resolve(
        signIns.filter((s) => s.memberId === member.memberId).map(({ memberId: _m, ...s }) => s),
      ),
    linkSignIn: (member, other): Promise<LinkResult> => {
      const existing = signIns.find((s) => s.userId === other.userId);
      if (existing) {
        const { memberId: _m, ...signIn } = existing;
        return Promise.resolve({ status: 'already_linked', signIn });
      }
      if (memberships[other.userId]?.orgId === OTHER_ORG) {
        return Promise.resolve({ status: 'has_own_organization' });
      }
      if (memberships[other.userId]) return Promise.resolve({ status: 'other_member' });
      const signIn = {
        id: `${SIGN_IN.slice(0, -1)}${signIns.length + 1}`,
        ...other,
        createdAt: NOW,
      };
      signIns.push({ ...signIn, memberId: member.memberId });
      memberships[other.userId] = member;
      audit.push(`linked:${other.email}`);
      return Promise.resolve({ status: 'linked', signIn });
    },
    unlinkSignIn: (member, signInId) => {
      const i = signIns.findIndex((s) => s.id === signInId && s.memberId === member.memberId);
      if (i === -1) return Promise.resolve('not_found' as const);
      const [gone] = signIns.splice(i, 1);
      delete memberships[gone!.userId];
      audit.push(`unlinked:${gone!.email}`);
      return Promise.resolve('removed' as const);
    },
    listFeatures: () => Promise.resolve([...switched.values()]),
    featureOn: (_org, flag) => Promise.resolve(switched.get(flag)?.enabled ?? false),
    switchFeature: (_member, { flag, enabled }) => {
      if ((switched.get(flag)?.enabled ?? false) === enabled) {
        return Promise.resolve('unchanged' as const);
      }
      switched.set(flag, { flag, enabled, updatedAt: NOW });
      audit.push(`feature:${flag}:${enabled ? 'on' : 'off'}`);
      return Promise.resolve('switched' as const);
    },
  };
  return { store, keys, audit, signIns };
}

function setup(
  verdict: ProviderVerdict = { ok: true, authScheme: 'api_key' },
  flagOverrides?: string,
) {
  const fake = fakeStore();
  const checked: { provider: string; key: string; preferred?: string }[] = [];
  const verify: ProviderKeyVerifier = (provider, key, preferred) => {
    checked.push({ provider, key, ...(preferred ? { preferred } : {}) });
    return Promise.resolve(verdict);
  };
  const secrets = createSecretBox('test-encryption-secret-123456');
  const api = createApi({
    version: 't',
    verifyToken: (token) => {
      const who = identities[token.split('.')[0]!];
      return who ? Promise.resolve(who) : Promise.reject(new AuthError('invalid_token', 'no'));
    },
    workspace: fake.store,
    secrets,
    verifyProviderKey: verify,
    flagOverrides,
    now: () => NOW,
  });
  const call = (method: string, path: string, who?: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { ...fake, call, checked, secrets };
}

describe('POST /v1/me/organization', () => {
  it('creates the organization on first sign-in, then returns it', async () => {
    const { call } = setup();
    const first = await call('POST', '/v1/me/organization', 'stranger');
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      organization: { id: ORG, name: "new's organization", homeCurrency: 'USD' },
      member: { id: MEMBER, role: 'owner' },
    });
    expect((await call('POST', '/v1/me/organization', 'stranger')).status).toBe(200);
  });

  it('needs a signed-in user with an email address', async () => {
    const { call } = setup();
    expect((await call('POST', '/v1/me/organization')).status).toBe(401);
    const res = await call('POST', '/v1/me/organization', 'noemail');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'email_required' });
  });
});

describe('AI provider keys', () => {
  it('lists every provider, none configured to begin with', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/settings/ai-providers', 'owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      providers: [
        {
          provider: 'anthropic',
          configured: false,
          keyHint: null,
          authScheme: null,
          verifiedAt: null,
          updatedAt: null,
        },
        {
          provider: 'openai',
          configured: false,
          keyHint: null,
          authScheme: null,
          verifiedAt: null,
          updatedAt: null,
        },
      ],
    });
  });

  it('checks a key with the provider, stores it encrypted and never returns it', async () => {
    const { call, keys, audit, checked, secrets } = setup({ ok: true, authScheme: 'bearer' });
    const res = await call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: '  sk-ant-usr-1h-secret-gAAA  ',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('secret');
    expect(JSON.parse(body)).toEqual({
      provider: 'anthropic',
      configured: true,
      keyHint: 'gAAA',
      authScheme: 'bearer',
      verifiedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(checked).toEqual([{ provider: 'anthropic', key: 'sk-ant-usr-1h-secret-gAAA' }]);

    const stored = keys.get('anthropic')!;
    expect(stored.ciphertext).not.toContain('secret');
    expect(secrets.open(stored.ciphertext, `${ORG}:anthropic`)).toBe('sk-ant-usr-1h-secret-gAAA');
    expect(audit).toEqual(['saved:anthropic:gAAA']);
  });

  it('stores nothing when the provider rejects the key or cannot be reached', async () => {
    const rejected = setup({ ok: false, reason: 'rejected', status: 401 });
    const res = await rejected.call('PUT', '/v1/settings/ai-providers/openai', 'owner', {
      apiKey: 'sk-wrong-key',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'key_rejected',
      title: 'OpenAI rejected this key',
    });
    expect(rejected.keys.size).toBe(0);

    const down = setup({ ok: false, reason: 'unreachable' });
    const res2 = await down.call('PUT', '/v1/settings/ai-providers/openai', 'owner', {
      apiKey: 'sk-some-key',
    });
    expect(res2.status).toBe(502);
    expect(await res2.json()).toMatchObject({ code: 'provider_unreachable' });
    expect(down.audit).toEqual([]);
  });

  it('says what the provider answered, so a failed check can be acted on', async () => {
    const refused = setup({ ok: false, reason: 'refused', status: 400, detail: 'bad request' });
    const res = await refused.call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: 'sk-ant-api03-some-key',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'key_refused',
      detail: 'Anthropic answered 400: bad request. Nothing was stored.',
    });

    const busy = setup({ ok: false, reason: 'unreachable', status: 529, detail: 'Overloaded' });
    const res2 = await busy.call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: 'sk-ant-api03-some-key',
    });
    expect(res2.status).toBe(502);
    expect(await res2.json()).toMatchObject({
      title: 'Anthropic is busy or having trouble',
      detail: 'Anthropic answered 529: Overloaded. Nothing was stored. Try again shortly.',
    });

    const silent = setup({
      ok: false,
      reason: 'unreachable',
      detail: 'no answer within 8 seconds',
    });
    const res3 = await silent.call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: 'sk-ant-api03-some-key',
    });
    expect(await res3.json()).toMatchObject({
      title: 'Anthropic could not be reached',
      detail:
        'No answer from Anthropic: no answer within 8 seconds. Nothing was stored. Try again shortly.',
    });
  });

  it('cleans what copying adds to a key before checking it, and refuses what is not a key', async () => {
    const { call, checked } = setup();
    // An env-file line pasted whole, with a line break and a zero-width space inside. Built at
    // runtime so the secret scanner doesn't read the fake key as a real one.
    const pasted = [' ANTHROPIC_API_KEY=', '"', 'sk-ant-api03-abc\n def\u200B', '" '].join('');
    const res = await call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: pasted,
    });
    expect(res.status).toBe(200);
    expect(checked).toEqual([{ provider: 'anthropic', key: 'sk-ant-api03-abcdef' }]);

    const bad = await call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: 'sk-ant-\u00e9t\u00e9-not-a-key',
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'key_malformed' });
    expect(checked).toHaveLength(1);
  });

  it('re-checks a stored key with its stored scheme, and records the check', async () => {
    const { call, audit, checked } = setup({ ok: true, authScheme: 'api_key' });
    await call('PUT', '/v1/settings/ai-providers/anthropic', 'owner', {
      apiKey: 'sk-ant-key-1234',
    });
    const res = await call('POST', '/v1/settings/ai-providers/anthropic/test', 'owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, status: { keyHint: '1234' } });
    expect(checked.at(-1)).toEqual({
      provider: 'anthropic',
      key: 'sk-ant-key-1234',
      preferred: 'api_key',
    });
    expect(audit).toEqual(['saved:anthropic:1234', 'verified:anthropic']);
  });

  it('reports a stored key that no longer works, or cannot be decrypted, without failing', async () => {
    const first = setup();
    await first.call('PUT', '/v1/settings/ai-providers/openai', 'owner', { apiKey: 'sk-key-9876' });
    // The same store, behind an API whose provider now rejects the key.
    const api = createApi({
      version: 't',
      verifyToken: (t) => Promise.resolve(identities[t]!),
      workspace: first.store,
      secrets: createSecretBox('test-encryption-secret-123456'),
      verifyProviderKey: () =>
        Promise.resolve({ ok: false, reason: 'rejected', status: 401, detail: 'key revoked' }),
    });
    const res = await api.request('/v1/settings/ai-providers/openai/test', {
      method: 'POST',
      headers: { authorization: 'Bearer owner' },
    });
    expect(await res.json()).toMatchObject({
      valid: false,
      reason: 'rejected',
      detail: 'OpenAI answered 401: key revoked',
    });

    // A rotated encryption secret makes the stored key unreadable: re-enter it.
    const rotated = createApi({
      version: 't',
      verifyToken: (t) => Promise.resolve(identities[t]!),
      workspace: first.store,
      secrets: createSecretBox('a-different-secret-after-rotation'),
      verifyProviderKey: () => Promise.resolve({ ok: true, authScheme: 'bearer' }),
    });
    const res2 = await rotated.request('/v1/settings/ai-providers/openai/test', {
      method: 'POST',
      headers: { authorization: 'Bearer owner' },
    });
    expect(await res2.json()).toMatchObject({ valid: false, reason: 'unreadable' });
  });

  it('removes a key, and says when there is none', async () => {
    const { call, audit } = setup();
    await call('PUT', '/v1/settings/ai-providers/openai', 'owner', { apiKey: 'sk-key-5555' });
    expect((await call('DELETE', '/v1/settings/ai-providers/openai', 'owner')).status).toBe(204);
    const again = await call('DELETE', '/v1/settings/ai-providers/openai', 'owner');
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: 'not_configured' });
    expect((await call('POST', '/v1/settings/ai-providers/openai/test', 'owner')).status).toBe(404);
    expect(audit).toEqual(['saved:openai:5555', 'removed:openai']);
  });

  it('lets only owners and finance admins manage keys', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/settings/ai-providers')).status).toBe(401);
    const member = await call('GET', '/v1/settings/ai-providers', 'member');
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ code: 'forbidden_role' });
    const outsider = await call('PUT', '/v1/settings/ai-providers/openai', 'stranger', {
      apiKey: 'sk-key-0000',
    });
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ code: 'no_organization' });
  });

  it('rejects unknown providers and short keys before calling anyone', async () => {
    const { call, checked } = setup();
    expect((await call('GET', '/v1/settings/ai-providers/gemini', 'owner')).status).toBe(404);
    expect(
      (await call('PUT', '/v1/settings/ai-providers/gemini', 'owner', { apiKey: 'sk-key-0000' }))
        .status,
    ).toBe(400);
    expect(
      (await call('PUT', '/v1/settings/ai-providers/openai', 'owner', { apiKey: 'short' })).status,
    ).toBe(400);
    expect(checked).toEqual([]);
  });

  it('answers 503 when the database or key storage is not configured', async () => {
    const bare = createApi({
      version: 't',
      verifyToken: (t) => Promise.resolve(identities[t]!),
    });
    const res = await bare.request('/v1/settings/ai-providers', {
      headers: { authorization: 'Bearer owner' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'database_not_configured' });

    const noKeys = createApi({
      version: 't',
      verifyToken: (t) => Promise.resolve(identities[t]!),
      workspace: fakeStore().store,
    });
    const res2 = await noKeys.request('/v1/settings/ai-providers/openai', {
      method: 'PUT',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-key-1111' }),
    });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toMatchObject({ code: 'encryption_not_configured' });
  });
});

/** An access token for the body: long enough for the schema, and names its identity. */
const token = (who: string) => `${who}.${'x'.repeat(24)}`;

describe('sign-ins', () => {
  it('lists the sign-ins that reach the caller, marking the current one', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/me/sign-ins', 'owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      signIns: [
        { id: SIGN_IN, email: 'owner@example.com', linkedAt: NOW.toISOString(), current: true },
      ],
    });
  });

  it('links a second sign-in with proof of both, once', async () => {
    const { call, audit } = setup();
    const res = await call('POST', '/v1/me/sign-ins', 'owner', { accessToken: token('work') });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email: 'o@work.example', current: false });
    const again = await call('POST', '/v1/me/sign-ins', 'owner', { accessToken: token('work') });
    expect(again.status).toBe(200);
    expect(audit).toEqual(['linked:o@work.example']);

    // The new sign-in now reaches the same person, and sees itself as current.
    const list = await call('GET', '/v1/me/sign-ins', 'work');
    const body = (await list.json()) as { signIns: { email: string; current: boolean }[] };
    expect(body.signIns.map((s) => [s.email, s.current])).toEqual([
      ['owner@example.com', false],
      ['o@work.example', true],
    ]);
  });

  it.each([
    ['an invalid token', token('nobody'), 'invalid_sign_in'],
    ['the caller’s own token', token('owner'), 'same_sign_in'],
    ['a token from an old sign-in', token('stale'), 'stale_sign_in'],
    ['an account without email', token('noemail'), 'email_required'],
  ])('refuses %s', async (_label, accessToken, code) => {
    const { call, audit } = setup();
    const res = await call('POST', '/v1/me/sign-ins', 'owner', { accessToken });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code });
    expect(audit).toEqual([]);
  });

  it('refuses a sign-in that has its own work, or belongs to someone else', async () => {
    const { call } = setup();
    const busy = await call('POST', '/v1/me/sign-ins', 'owner', { accessToken: token('busy') });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: 'sign_in_has_organization' });
    const taken = await call('POST', '/v1/me/sign-ins', 'owner', {
      accessToken: token('member'),
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'sign_in_in_use' });
  });

  it('needs an organization first', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/me/sign-ins', 'stranger');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'no_organization' });
  });

  it('removes another sign-in, but never the one making the request', async () => {
    const { call, audit } = setup();
    const linked = await call('POST', '/v1/me/sign-ins', 'owner', {
      accessToken: token('work'),
    });
    const { id } = (await linked.json()) as { id: string };

    const self = await call('DELETE', `/v1/me/sign-ins/${SIGN_IN}`, 'owner');
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: 'current_sign_in' });

    expect((await call('DELETE', `/v1/me/sign-ins/${id}`, 'owner')).status).toBe(204);
    expect((await call('DELETE', `/v1/me/sign-ins/${id}`, 'owner')).status).toBe(404);
    expect(audit).toEqual(['linked:o@work.example', 'unlinked:o@work.example']);
    expect((await call('GET', '/v1/me/sign-ins', 'work')).status).toBe(403);
  });
});

describe('features', () => {
  it('lists every feature switched off, and lets only the owner switch one', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/features', 'member');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: { key: string; enabled: boolean; source: string }[];
      canSwitch: boolean;
    };
    expect(body.canSwitch).toBe(false);
    expect(body.features.length).toBeGreaterThan(0);
    expect(body.features.every((f) => !f.enabled && f.source === 'default')).toBe(true);
    // The server's own flags are not the organization's to switch.
    expect(body.features.map((f) => f.key)).not.toContain('shell.build-version');

    const refused = await call('PUT', '/v1/settings/features/expenses.mileage', 'member', {
      enabled: true,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'forbidden_role' });
    const owner = (await (await call('GET', '/v1/features', 'owner')).json()) as {
      canSwitch: boolean;
    };
    expect(owner.canSwitch).toBe(true);
  });

  it('switches a feature on and off for the organization, with an audit event each time', async () => {
    const { call, audit } = setup();
    const on = await call('PUT', '/v1/settings/features/expenses.mileage', 'owner', {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      key: 'expenses.mileage',
      enabled: true,
      source: 'organization',
      switchedAt: NOW.toISOString(),
    });
    const list = (await (await call('GET', '/v1/features', 'member')).json()) as {
      features: { key: string; enabled: boolean }[];
    };
    expect(list.features.find((f) => f.key === 'expenses.mileage')?.enabled).toBe(true);

    // Switching it to what it already is records nothing.
    await call('PUT', '/v1/settings/features/expenses.mileage', 'owner', { enabled: true });
    await call('PUT', '/v1/settings/features/expenses.mileage', 'owner', { enabled: false });
    expect(audit).toEqual(['feature:expenses.mileage:on', 'feature:expenses.mileage:off']);
  });

  it('lets the server override beat the switch, and refuses a switch it would ignore', async () => {
    const { call, audit } = setup(undefined, 'expenses.mileage=on,reports.export=off');
    const list = (await (await call('GET', '/v1/features', 'owner')).json()) as {
      features: { key: string; enabled: boolean; source: string }[];
    };
    expect(list.features.find((f) => f.key === 'expenses.mileage')).toMatchObject({
      enabled: true,
      source: 'override',
    });
    const res = await call('PUT', '/v1/settings/features/reports.export', 'owner', {
      enabled: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'feature_overridden' });
    expect(audit).toEqual([]);
  });

  it('refuses a feature that does not exist, or one that is the server’s own', async () => {
    const { call } = setup();
    for (const key of ['expenses.nope', 'shell.build-version']) {
      const res = await call('PUT', `/v1/settings/features/${key}`, 'owner', { enabled: true });
      expect(res.status).toBe(400);
    }
  });
});
