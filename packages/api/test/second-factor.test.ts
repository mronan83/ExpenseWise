import type { OrgFeature } from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import { MODELS } from '@expensewise/extraction';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApi, type ApiOptions } from '../src/app.ts';
import { supabaseTokenVerifier, type TokenVerifier } from '../src/auth.ts';
import { featureGate } from '../src/features.ts';
import { ProblemError } from '../src/problem.ts';
import { requireAdminSecondFactor, requireSecondFactor } from '../src/second-factor.ts';
import { createSecretBox } from '../src/secret-box.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

/*
 * The second factor (F-11, FR-GOV-04): with tokens signed as Supabase Auth signs them, aal1
 * (password alone) and aal2 (passed the code), every admin action needs aal2 while the
 * organization has the second factor switched on, and nothing changes while it is off.
 */

const PROJECT = 'https://test-project.supabase.co';
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const OWNER_MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const OTHER_MEMBER = '0192f7a0-0000-7000-8000-0000000000b2';
const ID = '0192f7a0-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const FLAG = 'security.second-factor';

/** Who signs in: the user id is the token's subject. */
const ROLES: Record<string, MemberRole> = {
  'u-owner': 'owner',
  'u-finance': 'finance_admin',
  'u-member': 'member',
};

let verifyToken: TokenVerifier;
let sign: (user: string, aal: 'aal1' | 'aal2') => Promise<string>;

beforeAll(async () => {
  const project = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(project.publicKey)), kid: 'project-key', alg: 'ES256' };
  verifyToken = supabaseTokenVerifier({
    projectUrl: PROJECT,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  sign = (user, aal) =>
    new SignJWT({ role: 'authenticated', aal, email: `${user}@example.com`, session_id: 's-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'project-key' })
      .setSubject(user)
      .setIssuer(`${PROJECT}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(project.privateKey);
});

/**
 * One stand-in for every store an admin action touches. It knows each caller's membership and
 * the organization's switches; any other call means the request got past every check, and
 * answers 409 reached_store, so a test sees whether an action ran without each store's details.
 */
function setup(switchedOn: readonly string[] = [], flagOverrides?: string) {
  const switched = new Set(switchedOn);
  const reached: string[] = [];
  const known: Record<string, (...args: never[]) => Promise<unknown>> = {
    findMembership: (userId: string) =>
      Promise.resolve(
        ROLES[userId]
          ? {
              orgId: ORG,
              memberId: userId === 'u-owner' ? OWNER_MEMBER : OTHER_MEMBER,
              role: ROLES[userId],
            }
          : undefined,
      ),
    featureOn: (_org: string, flag: string) => Promise.resolve(switched.has(flag)),
    listFeatures: (): Promise<OrgFeature[]> =>
      Promise.resolve([...switched].map((flag) => ({ flag, enabled: true, updatedAt: NOW }))),
    switchFeature: (_who: unknown, change: { flag: string; enabled: boolean }) => {
      reached.push(`switchFeature:${change.flag}:${change.enabled ? 'on' : 'off'}`);
      if (change.enabled) switched.add(change.flag);
      else switched.delete(change.flag);
      return Promise.resolve();
    },
  };
  const store = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (
          known[property] ??
          (() => {
            reached.push(property);
            return Promise.reject(
              new ProblemError(409, 'reached-store', 'Reached the store', {
                code: 'reached_store',
              }),
            );
          })
        );
      },
    },
  ) as never;
  const options: ApiOptions = {
    version: 'test',
    verifyToken,
    workspace: store,
    organization: store,
    people: store,
    categories: store,
    mileageRates: store,
    modelSettings: store,
    receipts: store,
    routeKeys: store,
    secrets: createSecretBox('second-factor-test-secret-0123456789'),
    verifyProviderKey: () => Promise.resolve({ ok: true, authScheme: 'api_key' }),
    verifyRouteKey: () => Promise.resolve({ ok: true }),
    flagOverrides:
      flagOverrides ??
      [
        'settings.organization',
        'settings.duplicate-window',
        'team.invites',
        'reports.approval',
        'expenses.categories',
        'expenses.mileage',
        'expenses.route-mileage',
        'receipts.model-settings',
      ]
        .map((f) => `${f}=on`)
        .join(','),
  };
  const api = createApi(options);
  return {
    reached,
    switched,
    async call(user: string, aal: 'aal1' | 'aal2', method: string, path: string, body?: unknown) {
      const res = await api.request(path, {
        method,
        headers: {
          authorization: `Bearer ${await sign(user, aal)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text ? JSON.parse(text) : null) as { code?: string; detail?: string } | null,
      };
    },
  };
}

const KEY = '5b3ce3597851110001cf6248a1b2c3d4e5f60718293a4b5c6d7e8f90wxyz';

/** Every admin action: the owner's and finance admins' changes (FR-GOV-01, FR-GOV-04). */
const ADMIN_ACTIONS: [string, string, unknown?][] = [
  ['PUT', '/v1/settings/ai-providers/anthropic', { apiKey: 'sk-ant-api03-some-long-key-wxyz' }],
  ['POST', '/v1/settings/ai-providers/anthropic/test'],
  ['DELETE', '/v1/settings/ai-providers/anthropic'],
  ['PUT', '/v1/settings/ai-models', { primary: null, models: modelsOff() }],
  ['PUT', '/v1/settings/features/reports.export', { enabled: true }],
  ['PATCH', '/v1/settings/organization', { name: 'Acme' }],
  ['PUT', '/v1/settings/duplicate-window', { minutes: 45 }],
  ['PUT', '/v1/settings/mileage-rates/2026-11-01', { perMile: '0.70' }],
  ['PUT', '/v1/settings/mileage/route-key', { apiKey: KEY }],
  ['DELETE', '/v1/settings/mileage/route-key'],
  ['POST', '/v1/settings/categories', { name: 'Travel' }],
  ['PATCH', `/v1/settings/categories/${ID}`, { name: 'Travel' }],
  ['DELETE', `/v1/settings/categories/${ID}`],
  ['POST', '/v1/settings/expense-types', { name: 'Airfare' }],
  ['PATCH', `/v1/settings/expense-types/${ID}`, { name: 'Airfare' }],
  ['DELETE', `/v1/settings/expense-types/${ID}`],
  ['POST', '/v1/settings/people/invites', { role: 'member' }],
  ['DELETE', `/v1/settings/people/invites/${ID}`],
  ['PATCH', `/v1/settings/people/${OTHER_MEMBER}`, { role: 'approver' }],
  ['PUT', `/v1/settings/people/${OTHER_MEMBER}/approver`, { approverId: OWNER_MEMBER }],
  ['DELETE', `/v1/settings/people/${OTHER_MEMBER}`],
];

function modelsOff() {
  return Object.keys(MODELS).map((model) => ({ model, enabled: false }));
}

/** Whether the action ran: it reached its store, or (a switch) switched. */
const ran = (res: { status: number; body: { code?: string } | null }) =>
  res.status === 200 || res.body?.code === 'reached_store';

describe('requireSecondFactor', () => {
  it('lets an aal2 session through, and refuses aal1 with 403 second_factor_required', () => {
    expect(() => requireSecondFactor({ assuranceLevel: 'aal2' })).not.toThrow();
    let refusal: unknown;
    try {
      requireSecondFactor({ assuranceLevel: 'aal1' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProblemError);
    expect(refusal).toMatchObject({ status: 403, extra: { code: 'second_factor_required' } });
  });
});

describe('requireAdminSecondFactor', () => {
  const gate = (on: boolean) => {
    let reads = 0;
    const workspace = {
      featureOn: () => {
        reads += 1;
        return Promise.resolve(on);
      },
    } as unknown as WorkspaceStore;
    return { gate: featureGate({ workspace }), reads: () => reads };
  };

  it('asks nothing of anyone while the second factor is switched off', async () => {
    const { gate: off } = gate(false);
    await expect(requireAdminSecondFactor(off, ORG, { assuranceLevel: 'aal1' })).resolves.toBe(
      undefined,
    );
  });

  it('refuses an aal1 session while it is on, and never reads the switch for aal2', async () => {
    const on = gate(true);
    await expect(
      requireAdminSecondFactor(on.gate, ORG, { assuranceLevel: 'aal1' }),
    ).rejects.toMatchObject({ status: 403, extra: { code: 'second_factor_required' } });
    expect(on.reads()).toBe(1);
    await requireAdminSecondFactor(on.gate, ORG, { assuranceLevel: 'aal2' });
    expect(on.reads()).toBe(1);
  });

  it('lets the server’s override switch it off for everyone, the kill switch', async () => {
    const killed = featureGate({
      workspace: { featureOn: () => Promise.resolve(true) } as unknown as WorkspaceStore,
      flagOverrides: `${FLAG}=off`,
    });
    await expect(requireAdminSecondFactor(killed, ORG, { assuranceLevel: 'aal1' })).resolves.toBe(
      undefined,
    );
  });
});

describe('admin actions while the second factor is switched on (FR-GOV-04)', () => {
  it.each(ADMIN_ACTIONS)(
    'refuses every admin action from a password-only session, and does nothing: %s %s',
    async (method, path, body) => {
      const s = setup([FLAG]);
      const res = await s.call('u-owner', 'aal1', method, path, body);
      expect(res).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
      expect(s.reached).toEqual([]);
    },
  );

  it.each(ADMIN_ACTIONS)(
    'lets every admin action through once the session passed the code: %s %s',
    async (method, path, body) => {
      const s = setup([FLAG]);
      expect(ran(await s.call('u-owner', 'aal2', method, path, body))).toBe(true);
      expect(s.reached).not.toEqual([]);
    },
  );

  it('asks a finance admin for the code too, and still tells a member it isn’t theirs', async () => {
    const s = setup([FLAG]);
    expect(
      await s.call('u-finance', 'aal1', 'POST', '/v1/settings/categories', { name: 'Travel' }),
    ).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
    expect(
      ran(await s.call('u-finance', 'aal2', 'POST', '/v1/settings/categories', { name: 'Travel' })),
    ).toBe(true);
    expect(
      await s.call('u-member', 'aal2', 'POST', '/v1/settings/categories', { name: 'Travel' }),
    ).toMatchObject({ status: 403, body: { code: 'forbidden_role' } });
  });

  it('leaves reading the settings to a password alone', async () => {
    const s = setup([FLAG]);
    const keys = await s.call('u-owner', 'aal1', 'GET', '/v1/settings/ai-providers');
    expect(keys.body?.code).toBe('reached_store');
    const features = await s.call('u-owner', 'aal1', 'GET', '/v1/features');
    expect(features.status).toBe(200);
  });
});

describe('admin actions while the second factor is switched off', () => {
  it.each(ADMIN_ACTIONS)(
    'lets every admin action through on a password alone, as before: %s %s',
    async (method, path, body) => {
      const s = setup([]);
      expect(ran(await s.call('u-owner', 'aal1', method, path, body))).toBe(true);
    },
  );

  it('asks for nothing while the server’s override has it off, whatever the switch says', async () => {
    const s = setup([FLAG], `${FLAG}=off,expenses.categories=on`);
    expect(
      ran(await s.call('u-owner', 'aal1', 'POST', '/v1/settings/categories', { name: 'Travel' })),
    ).toBe(true);
  });
});

describe('switching the second factor on (no lockout)', () => {
  it('refuses an owner whose own session has not passed the code, and switches nothing', async () => {
    const s = setup([]);
    const res = await s.call('u-owner', 'aal1', 'PUT', `/v1/settings/features/${FLAG}`, {
      enabled: true,
    });
    expect(res).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
    expect(res.body?.detail).toMatch(/Settings › Sign-ins/);
    expect(s.reached).toEqual([]);
    expect(s.switched.has(FLAG)).toBe(false);
  });

  it('switches it on for an owner who passed the code, then asks it of every admin action', async () => {
    const s = setup([]);
    const res = await s.call('u-owner', 'aal2', 'PUT', `/v1/settings/features/${FLAG}`, {
      enabled: true,
    });
    expect(res).toMatchObject({ status: 200, body: { key: FLAG, enabled: true } });
    expect(s.reached).toEqual([`switchFeature:${FLAG}:on`]);
    expect(
      await s.call('u-owner', 'aal1', 'PUT', '/v1/settings/features/reports.export', {
        enabled: true,
      }),
    ).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
  });

  it('needs the code to switch it off again, so a password alone can’t undo it', async () => {
    const s = setup([FLAG]);
    expect(
      await s.call('u-owner', 'aal1', 'PUT', `/v1/settings/features/${FLAG}`, { enabled: false }),
    ).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
    expect(
      await s.call('u-owner', 'aal2', 'PUT', `/v1/settings/features/${FLAG}`, { enabled: false }),
    ).toMatchObject({ status: 200, body: { enabled: false } });
  });

  it('still lets an aal1 owner switch other features on while it is off', async () => {
    const s = setup([]);
    expect(
      await s.call('u-owner', 'aal1', 'PUT', '/v1/settings/features/reports.export', {
        enabled: true,
      }),
    ).toMatchObject({ status: 200, body: { enabled: true } });
  });
});
