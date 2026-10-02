import type { AiProvider, Membership, StoredProviderKey } from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import type { ProviderKeyVerifier, ProviderVerdict } from '../src/ai-providers.ts';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-02T12:00:00.000Z');

const identities: Record<string, Identity> = {
  owner: { userId: 'u-owner', email: 'owner@example.com', assuranceLevel: 'aal1', sessionId: 's' },
  member: { userId: 'u-member', email: 'm@example.com', assuranceLevel: 'aal1', sessionId: 's' },
  stranger: { userId: 'u-new', email: 'new@example.com', assuranceLevel: 'aal1', sessionId: 's' },
  noemail: { userId: 'u-x', email: null, assuranceLevel: 'aal1', sessionId: 's' },
};

/** An in-memory store with one organization: an owner and a plain member. */
function fakeStore() {
  const memberships: Record<string, Membership> = {
    'u-owner': { orgId: ORG, memberId: MEMBER, role: 'owner' },
    'u-member': { orgId: ORG, memberId: MEMBER, role: 'member' },
  };
  const keys = new Map<AiProvider, StoredProviderKey>();
  const audit: string[] = [];
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
  };
  return { store, keys, audit };
}

function setup(verdict: ProviderVerdict = { ok: true, authScheme: 'api_key' }) {
  const fake = fakeStore();
  const checked: { provider: string; key: string; preferred?: string }[] = [];
  const verify: ProviderKeyVerifier = (provider, key, preferred) => {
    checked.push({ provider, key, ...(preferred ? { preferred } : {}) });
    return Promise.resolve(verdict);
  };
  const secrets = createSecretBox('test-encryption-secret-123456');
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identities[token]!),
    workspace: fake.store,
    secrets,
    verifyProviderKey: verify,
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
      verifyProviderKey: () => Promise.resolve({ ok: false, reason: 'rejected', status: 401 }),
    });
    const res = await api.request('/v1/settings/ai-providers/openai/test', {
      method: 'POST',
      headers: { authorization: 'Bearer owner' },
    });
    expect(await res.json()).toMatchObject({ valid: false, reason: 'rejected' });

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
