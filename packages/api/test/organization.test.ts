import type { Membership, OrganizationRecord } from '@expensewise/db';
import { applyOrganizationEdit } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { AuthError, type Identity } from '../src/auth.ts';
import type { OrganizationStore } from '../src/organization.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const OWNER = '0192f7a0-0000-7000-8000-0000000000b1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b2';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const identity = (userId: string, email: string): Identity => ({
  userId,
  email,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});
const identities: Record<string, Identity> = {
  // The owner signs in with either of two addresses, linked to one member (Q17, Q24).
  owner: identity('u-owner', 'owner@example.com'),
  work: identity('u-work', 'owner@work.example'),
  member: identity('u-member', 'm@example.com'),
  stranger: identity('u-new', 'new@example.com'),
};

/** One organization: its owner, with two sign-ins, and a plain member. */
function setup(flagOverrides?: string) {
  const memberships: Record<string, Membership> = {
    'u-owner': { orgId: ORG, memberId: OWNER, role: 'owner' },
    'u-work': { orgId: ORG, memberId: OWNER, role: 'owner' },
    'u-member': { orgId: ORG, memberId: MEMBER, role: 'member' },
  };
  let org: OrganizationRecord = {
    id: ORG,
    name: "owner's organization",
    homeCurrency: 'USD',
    country: null,
    locale: null,
    timeZone: null,
    address: null,
    industry: null,
    size: null,
    duplicateWindowMinutes: null,
  };
  const audit: unknown[] = [];
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    ensureOrganization: ({ userId }: { userId: string }) =>
      Promise.resolve({
        membership: memberships[userId] ?? { orgId: ORG, memberId: OWNER, role: 'owner' },
        organization: { id: ORG, name: org.name, homeCurrency: org.homeCurrency },
        created: false,
      }),
    listFeatures: () => Promise.resolve([]),
    featureOn: () => Promise.resolve(false),
  } as unknown as WorkspaceStore;
  const organization: OrganizationStore = {
    get: () => Promise.resolve(org),
    update: (_orgId, edit, actor) => {
      const applied = applyOrganizationEdit(org, edit);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      if (applied.value.changes.length === 0) {
        return Promise.resolve({ status: 'unchanged', organization: org });
      }
      org = { ...org, ...applied.value.details };
      audit.push({ actor, action: 'organization.updated', changes: applied.value.changes });
      return Promise.resolve({
        status: 'updated',
        organization: org,
        changes: applied.value.changes,
      });
    },
    setDuplicateWindow: (_orgId, minutes, actor) => {
      const from = org.duplicateWindowMinutes ?? 30;
      if (from === minutes) return Promise.resolve({ status: 'unchanged', minutes });
      org = { ...org, duplicateWindowMinutes: minutes };
      audit.push({ actor, action: 'organization.duplicate_window_set', from, to: minutes });
      return Promise.resolve({ status: 'changed', from, to: minutes });
    },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => {
      const who = identities[token];
      return who ? Promise.resolve(who) : Promise.reject(new AuthError('invalid_token', 'no'));
    },
    workspace,
    organization,
    flagOverrides,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, audit, current: () => org };
}

const BOTH = 'settings.organization=on,settings.duplicate-window=on';

describe('Settings › Organization (FR-PLT-11)', () => {
  it('answers 404 feature_off while organization settings are off, so they look absent', async () => {
    const { call } = setup();
    for (const [method, path, body] of [
      ['GET', '/v1/settings/organization'],
      ['PATCH', '/v1/settings/organization', { name: 'Acme' }],
      ['GET', '/v1/settings/duplicate-window'],
      ['PUT', '/v1/settings/duplicate-window', { minutes: 45 }],
    ] as const) {
      const res = await call(method, path, 'owner', body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.code).toBe('feature_off');
    }
  });

  it('shows every member the details and their own role, and lets only the owner change them', async () => {
    const { call, audit } = setup('settings.organization=on');
    const owner = await call('GET', '/v1/settings/organization', 'owner');
    expect(owner).toMatchObject({
      status: 200,
      body: {
        organization: { id: ORG, name: "owner's organization", homeCurrency: 'USD', size: null },
        role: 'owner',
        canEdit: true,
      },
    });
    const member = await call('GET', '/v1/settings/organization', 'member');
    expect(member.body).toMatchObject({ role: 'member', canEdit: false });
    const refused = await call('PATCH', '/v1/settings/organization', 'member', { name: 'Mine' });
    expect(refused).toMatchObject({ status: 403, body: { code: 'forbidden_role' } });
    expect(audit).toEqual([]);

    const saved = await call('PATCH', '/v1/settings/organization', 'owner', {
      name: 'Acme Field Services',
      homeCurrency: 'EUR',
      country: 'us',
      locale: 'en-US',
      timeZone: 'America/Chicago',
      address: '1520 Harney St\nOmaha, NE 68102',
      industry: 'Professional services',
      size: '2_10',
    });
    expect(saved).toMatchObject({
      status: 200,
      body: {
        organization: {
          name: 'Acme Field Services',
          homeCurrency: 'EUR',
          country: 'US',
          timeZone: 'America/Chicago',
          size: '2_10',
        },
        role: 'owner',
      },
    });
    expect(audit).toMatchObject([{ actor: 'u-owner', action: 'organization.updated' }]);
  });

  it('refuses a value that isn’t one, naming the field, and a request that changes nothing', async () => {
    const { call } = setup('settings.organization=on');
    const zone = await call('PATCH', '/v1/settings/organization', 'owner', {
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(zone).toMatchObject({ status: 422, body: { code: 'invalid_value', field: 'timeZone' } });
    const blank = await call('PATCH', '/v1/settings/organization', 'owner', { name: '  ' });
    expect(blank).toMatchObject({ status: 422, body: { field: 'name' } });
    const nothing = await call('PATCH', '/v1/settings/organization', 'owner', {});
    expect(nothing).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    const unknown = await call('PATCH', '/v1/settings/organization', 'owner', { vat: '1' });
    expect(unknown.status).toBe(400);
  });

  it('needs a signed-in member of an organization', async () => {
    const { call } = setup(BOTH);
    expect((await call('GET', '/v1/settings/organization')).status).toBe(401);
    const stranger = await call('GET', '/v1/settings/organization', 'stranger');
    expect(stranger).toMatchObject({ status: 403, body: { code: 'no_organization' } });
  });

  it('tells each of a person’s sign-ins the same role, for Settings to show (Q24)', async () => {
    const { call } = setup('settings.organization=on');
    for (const who of ['owner', 'work']) {
      const ensured = await call('POST', '/v1/me/organization', who);
      expect(ensured.body).toMatchObject({ member: { id: OWNER, role: 'owner' } });
      expect((await call('GET', '/v1/settings/organization', who)).body.role).toBe('owner');
    }
  });
});

describe('Settings › Organization: the duplicate time window (FR-INT-19)', () => {
  it('shows the window, 30 minutes until the owner sets another, with its bounds', async () => {
    const { call } = setup('settings.duplicate-window=on');
    expect(await call('GET', '/v1/settings/duplicate-window', 'member')).toEqual({
      status: 200,
      body: { minutes: 30, defaultMinutes: 30, maxMinutes: 120, canEdit: false },
    });
    expect((await call('GET', '/v1/settings/duplicate-window', 'owner')).body.canEdit).toBe(true);
  });

  it('lets only the owner set it, for everyone, from 0 to 120 whole minutes, each change audited', async () => {
    const { call, audit, current } = setup('settings.duplicate-window=on');
    const refused = await call('PUT', '/v1/settings/duplicate-window', 'member', { minutes: 5 });
    expect(refused).toMatchObject({ status: 403, body: { code: 'forbidden_role' } });
    for (const minutes of [-1, 121, 2.5]) {
      const res = await call('PUT', '/v1/settings/duplicate-window', 'owner', { minutes });
      expect(res.status, `${minutes}`).toBe(400);
    }
    expect(current().duplicateWindowMinutes).toBeNull();

    const set = await call('PUT', '/v1/settings/duplicate-window', 'owner', { minutes: 45 });
    expect(set).toMatchObject({ status: 200, body: { minutes: 45, canEdit: true } });
    expect((await call('GET', '/v1/settings/duplicate-window', 'member')).body.minutes).toBe(45);
    const sameMinute = await call('PUT', '/v1/settings/duplicate-window', 'owner', { minutes: 0 });
    expect(sameMinute.body.minutes).toBe(0);
    await call('PUT', '/v1/settings/duplicate-window', 'owner', { minutes: 0 });
    expect(audit).toEqual([
      { actor: 'u-owner', action: 'organization.duplicate_window_set', from: 30, to: 45 },
      { actor: 'u-owner', action: 'organization.duplicate_window_set', from: 45, to: 0 },
    ]);
  });

  it('keeps each section to its own flag', async () => {
    const windowOnly = setup('settings.duplicate-window=on');
    expect((await windowOnly.call('GET', '/v1/settings/organization', 'owner')).status).toBe(404);
    expect((await windowOnly.call('GET', '/v1/settings/duplicate-window', 'owner')).status).toBe(
      200,
    );
    const detailsOnly = setup('settings.organization=on');
    expect((await detailsOnly.call('GET', '/v1/settings/organization', 'owner')).status).toBe(200);
    expect((await detailsOnly.call('GET', '/v1/settings/duplicate-window', 'owner')).status).toBe(
      404,
    );
  });
});
