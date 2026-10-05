import type {
  AcceptInviteResult,
  InviteLookup,
  InviteRecord,
  Membership,
  PersonRecord,
} from '@expensewise/db';
import {
  inviteExpiresAt,
  leavesNoOwner,
  mayChooseApprover,
  routeReport,
  type MemberRole,
} from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { AuthError, type Identity } from '../src/auth.ts';
import type { PeopleStore } from '../src/people.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const OWNER = '0192f7a0-0000-7000-8000-0000000000b1';
const SAM = '0192f7a0-0000-7000-8000-0000000000b2';
const CASEY = '0192f7a0-0000-7000-8000-0000000000b3';
const INVITE = '0192f7a0-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const TOKEN = 'A'.repeat(43);

const identity = (userId: string, email: string | null = `${userId}@example.com`): Identity => ({
  userId,
  email,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});
const identities: Record<string, Identity> = {
  riley: identity('riley'),
  sam: identity('sam'),
  casey: identity('casey'),
  /** Riley, in a session that passed the second factor. */
  'riley-aal2': { ...identity('riley'), assuranceLevel: 'aal2' },
  newcomer: identity('newcomer'),
  noemail: identity('noemail', null),
};

/** Casey, an approver who joined after Sam, for a test that asks for a third person. */
const casey: PersonRecord = {
  memberId: CASEY,
  displayName: 'casey',
  email: 'casey@example.com',
  role: 'approver',
  joinedAt: new Date(NOW.getTime() + 60_000),
  removedAt: null,
};

function setup(
  flagOverrides: string | undefined = 'team.invites=on',
  others: readonly PersonRecord[] = [],
) {
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: OWNER, role: 'owner' },
    sam: { orgId: ORG, memberId: SAM, role: 'member' },
    ...Object.fromEntries(
      others.map((p) => [p.displayName, { orgId: ORG, memberId: p.memberId, role: p.role }]),
    ),
  };
  const people: PersonRecord[] = [
    {
      memberId: OWNER,
      displayName: 'riley',
      email: 'riley@example.com',
      role: 'owner',
      joinedAt: NOW,
      removedAt: null,
    },
    {
      memberId: SAM,
      displayName: 'sam',
      email: 'sam@example.com',
      role: 'member',
      joinedAt: NOW,
      removedAt: null,
    },
    ...others,
  ];
  /** Each member's chosen approver, as members.manager_member_id keeps it. */
  const managers = new Map<string, string>();
  const invites: InviteRecord[] = [];
  const audit: string[] = [];
  const workspace = {
    findMembership: (userId: string) => Promise.resolve(memberships[userId]),
    listFeatures: () => Promise.resolve([]),
    featureOn: () => Promise.resolve(false),
  } as unknown as WorkspaceStore;
  const owners = () => people.filter((p) => p.role === 'owner' && !p.removedAt).length;
  let lookup: InviteLookup | undefined;
  let accepted: AcceptInviteResult = { status: 'not_found' };
  const store: PeopleStore = {
    list: () => Promise.resolve({ people, invites }),
    invite: (by, input, _actor, now) => {
      const invite: InviteRecord = {
        id: INVITE,
        ...input,
        createdBy: 'riley',
        createdAt: now,
        expiresAt: inviteExpiresAt(now),
        acceptedAt: null,
        revokedAt: null,
      };
      invites.push(invite);
      audit.push(`invite:${input.role}:${by.memberId}`);
      return Promise.resolve({ invite, token: TOKEN });
    },
    revokeInvite: (_org, id) => {
      const i = invites.findIndex((x) => x.id === id);
      if (i === -1) return Promise.resolve('missing' as const);
      invites.splice(i, 1);
      audit.push(`revoked:${id}`);
      return Promise.resolve('revoked' as const);
    },
    changeRole: (_org, memberId, role: MemberRole) => {
      const i = people.findIndex((p) => p.memberId === memberId && !p.removedAt);
      if (i === -1) return Promise.resolve('missing' as const);
      if (leavesNoOwner(people[i]!, owners(), role)) return Promise.resolve('last_owner' as const);
      people[i] = { ...people[i]!, role };
      audit.push(`role:${memberId}:${role}`);
      return Promise.resolve('changed' as const);
    },
    remove: (_org, memberId, _actor, now) => {
      const i = people.findIndex((p) => p.memberId === memberId && !p.removedAt);
      if (i === -1) return Promise.resolve('missing' as const);
      if (leavesNoOwner(people[i]!, owners(), 'removed')) {
        return Promise.resolve('last_owner' as const);
      }
      people[i] = { ...people[i]!, removedAt: now };
      audit.push(`removed:${memberId}`);
      return Promise.resolve('removed' as const);
    },
    approvers: () => {
      const active = people
        .filter((p) => !p.removedAt)
        .map((p) => ({
          memberId: p.memberId,
          role: p.role,
          joinedAt: p.joinedAt,
          managerMemberId: managers.get(p.memberId) ?? null,
        }));
      return Promise.resolve(
        active.map((m) => {
          const route = routeReport(m, active);
          return {
            memberId: m.memberId,
            chosenMemberId: m.managerMemberId,
            goesToMemberId: route.goesTo,
            passedOver: route.passedOver,
            choices: active.filter((c) => mayChooseApprover(c, m.memberId)).map((c) => c.memberId),
          };
        }),
      );
    },
    chooseApprover: (_org, memberId, approverId) => {
      const active = people.filter((p) => !p.removedAt);
      if (!active.some((p) => p.memberId === memberId)) return Promise.resolve('missing' as const);
      if (approverId === memberId) return Promise.resolve('own_approver' as const);
      const approver = active.find((p) => p.memberId === approverId);
      if (approverId !== null && !(approver && mayChooseApprover(approver, memberId))) {
        return Promise.resolve('not_an_approver' as const);
      }
      if ((managers.get(memberId) ?? null) === approverId) {
        return Promise.resolve('unchanged' as const);
      }
      if (approverId === null) managers.delete(memberId);
      else managers.set(memberId, approverId);
      audit.push(`approver:${memberId}:${approverId}`);
      return Promise.resolve('changed' as const);
    },
    lookUp: (token) => Promise.resolve(token === TOKEN ? lookup : undefined),
    accept: (token, caller) => {
      audit.push(`accept:${caller.userId}`);
      return Promise.resolve(token === TOKEN ? accepted : { status: 'not_found' as const });
    },
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => {
      const who = identities[token];
      return who ? Promise.resolve(who) : Promise.reject(new AuthError('invalid_token', 'no'));
    },
    workspace,
    people: store,
    flagOverrides,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who?: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : null) as Record<string, unknown>,
    };
  };
  const offer = (found: Partial<InviteLookup>) => {
    lookup = {
      id: INVITE,
      orgId: ORG,
      organizationName: 'Acme',
      role: 'approver',
      expiresAt: inviteExpiresAt(NOW),
      state: 'pending',
      standing: 'none',
      ...found,
    };
  };
  const answer = (result: AcceptInviteResult) => {
    accepted = result;
  };
  return { call, people, invites, audit, offer, answer };
}

describe('Settings › People (#29)', () => {
  it('lists everyone with their role, and the open invite links, to an owner', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/settings/people', 'riley');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      people: [
        {
          id: OWNER,
          name: 'riley',
          email: 'riley@example.com',
          role: 'owner',
          joinedAt: NOW.toISOString(),
          removedAt: null,
          you: true,
        },
        {
          id: SAM,
          name: 'sam',
          email: 'sam@example.com',
          role: 'member',
          joinedAt: NOW.toISOString(),
          removedAt: null,
          you: false,
        },
      ],
      invites: [],
    });
  });

  it('makes an invite link with a role, showing its secret only once', async () => {
    const { call, audit } = setup();
    const res = await call('POST', '/v1/settings/people/invites', 'riley', {
      role: 'approver',
      label: '  For Sam  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      invite: {
        id: INVITE,
        role: 'approver',
        label: 'For Sam',
        expiresAt: '2026-10-11T12:00:00.000Z',
        expired: false,
      },
      token: TOKEN,
      path: `/invite/${TOKEN}`,
    });
    expect(audit).toEqual([`invite:approver:${OWNER}`]);
    const listed = await call('GET', '/v1/settings/people', 'riley');
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect((await call('DELETE', `/v1/settings/people/invites/${INVITE}`, 'riley')).status).toBe(
      204,
    );
    expect((await call('DELETE', `/v1/settings/people/invites/${INVITE}`, 'riley')).status).toBe(
      404,
    );
  });

  it('changes a role and removes a member, never leaving the organization without an owner', async () => {
    const { call, audit } = setup();
    const changed = await call('PATCH', `/v1/settings/people/${SAM}`, 'riley', {
      role: 'finance_admin',
    });
    expect(changed).toMatchObject({ status: 200, body: { id: SAM, role: 'finance_admin' } });
    const demote = await call('PATCH', `/v1/settings/people/${OWNER}`, 'riley', { role: 'member' });
    expect(demote).toMatchObject({ status: 409, body: { code: 'last_owner' } });
    const self = await call('DELETE', `/v1/settings/people/${OWNER}`, 'riley');
    expect(self).toMatchObject({ status: 409, body: { code: 'cannot_remove_self' } });
    expect((await call('DELETE', `/v1/settings/people/${SAM}`, 'riley')).status).toBe(204);
    expect((await call('DELETE', `/v1/settings/people/${SAM}`, 'riley')).status).toBe(404);
    expect(audit).toEqual([`role:${SAM}:finance_admin`, `removed:${SAM}`]);
  });

  it('lets only an owner manage people', async () => {
    const { call, audit } = setup();
    for (const [method, path, body] of [
      ['GET', '/v1/settings/people'],
      ['POST', '/v1/settings/people/invites', { role: 'owner' }],
      ['PATCH', `/v1/settings/people/${SAM}`, { role: 'owner' }],
      ['DELETE', `/v1/settings/people/${OWNER}`],
    ] as const) {
      const res = await call(method, path, 'sam', body);
      expect(res, `${method} ${path}`).toMatchObject({
        status: 403,
        body: { code: 'forbidden_role' },
      });
    }
    expect(audit).toEqual([]);
  });

  it('answers 404 feature_off while inviting people is switched off', async () => {
    // No override: the organization has not switched it on.
    const { call, offer } = setup('');
    offer({});
    for (const [method, path, body] of [
      ['GET', '/v1/settings/people'],
      ['POST', '/v1/settings/people/invites', { role: 'member' }],
      ['POST', '/v1/invites/look-up', { token: TOKEN }],
      ['POST', '/v1/invites/accept', { token: TOKEN }],
    ] as const) {
      const res = await call(method, path, 'riley', body);
      expect(res, `${method} ${path}`).toMatchObject({
        status: 404,
        body: { code: 'feature_off' },
      });
    }
  });
});

describe('choosing who approves each member’s reports (#86)', () => {
  const ON = 'team.invites=on,reports.approval=on';
  const ref = (id: string, name: string) => ({ id, name });
  type Listed = { id: string; approver?: Record<string, unknown> }[];
  const approverOf = (body: Record<string, unknown>, id: string) =>
    (body.people as Listed).find((p) => p.id === id)?.approver;

  it('shows who approves each person’s reports while approval is on, and whom an owner may choose', async () => {
    const { call } = setup(ON, [casey]);
    const res = await call('GET', '/v1/settings/people', 'riley');
    expect(res.status).toBe(200);
    expect(approverOf(res.body, SAM)).toEqual({
      chosen: null,
      goesTo: ref(CASEY, 'casey'),
      passedOver: false,
      choices: [ref(OWNER, 'riley'), ref(CASEY, 'casey')],
    });
    expect(approverOf(res.body, CASEY)).toEqual({
      chosen: null,
      goesTo: ref(OWNER, 'riley'),
      passedOver: false,
      choices: [ref(OWNER, 'riley')],
    });
    expect(approverOf(res.body, OWNER)).toMatchObject({ goesTo: ref(CASEY, 'casey') });
  });

  it('chooses a member’s approver, and goes back to Automatic, each change audited once', async () => {
    const { call, audit } = setup(ON, [casey]);
    const chosen = await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley', {
      approverId: OWNER,
    });
    expect(chosen).toMatchObject({
      status: 200,
      body: {
        id: SAM,
        approver: { chosen: ref(OWNER, 'riley'), goesTo: ref(OWNER, 'riley'), passedOver: false },
      },
    });
    const again = await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley', {
      approverId: OWNER,
    });
    expect(again.status).toBe(200);
    const automatic = await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley', {
      approverId: null,
    });
    expect(automatic).toMatchObject({
      status: 200,
      body: { approver: { chosen: null, goesTo: ref(CASEY, 'casey'), passedOver: false } },
    });
    expect(audit).toEqual([`approver:${SAM}:${OWNER}`, `approver:${SAM}:null`]);
  });

  it('refuses a member as their own approver, and anyone who can’t approve', async () => {
    const { call, audit } = setup(ON, [casey]);
    const own = await call('PUT', `/v1/settings/people/${CASEY}/approver`, 'riley', {
      approverId: CASEY,
    });
    expect(own).toMatchObject({ status: 422, body: { code: 'own_approver' } });
    for (const approverId of [SAM, INVITE]) {
      const res = await call('PUT', `/v1/settings/people/${CASEY}/approver`, 'riley', {
        approverId,
      });
      expect(res, approverId).toMatchObject({ status: 422, body: { code: 'not_an_approver' } });
    }
    const nobody = await call('PUT', `/v1/settings/people/${INVITE}/approver`, 'riley', {
      approverId: null,
    });
    expect(nobody).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(audit).toEqual([]);
  });

  it('says when the approver chosen can no longer approve, and finds one as Automatic does', async () => {
    const { call } = setup(ON, [casey]);
    await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley', { approverId: CASEY });
    await call('PATCH', `/v1/settings/people/${CASEY}`, 'riley', { role: 'member' });
    const demoted = await call('GET', '/v1/settings/people', 'riley');
    expect(approverOf(demoted.body, SAM)).toEqual({
      chosen: ref(CASEY, 'casey'),
      goesTo: ref(OWNER, 'riley'),
      passedOver: true,
      choices: [ref(OWNER, 'riley')],
    });
    await call('PATCH', `/v1/settings/people/${CASEY}`, 'riley', { role: 'approver' });
    await call('DELETE', `/v1/settings/people/${CASEY}`, 'riley');
    const removed = await call('GET', '/v1/settings/people', 'riley');
    expect(approverOf(removed.body, SAM)).toMatchObject({
      chosen: ref(CASEY, 'casey'),
      goesTo: ref(OWNER, 'riley'),
      passedOver: true,
    });
    // Someone removed has no approver to show.
    expect(approverOf(removed.body, CASEY)).toBeUndefined();
  });

  it('lets only an owner choose', async () => {
    const { call, audit } = setup(ON, [casey]);
    for (const who of ['sam', 'casey']) {
      const res = await call('PUT', `/v1/settings/people/${SAM}/approver`, who, {
        approverId: CASEY,
      });
      expect(res, who).toMatchObject({ status: 403, body: { code: 'forbidden_role' } });
    }
    expect(audit).toEqual([]);
  });

  it('asks the owner for the second factor while it is on', async () => {
    const { call, audit } = setup(`${ON},security.second-factor=on`, [casey]);
    const refused = await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley', {
      approverId: CASEY,
    });
    expect(refused).toMatchObject({ status: 403, body: { code: 'second_factor_required' } });
    expect(audit).toEqual([]);
    const passed = await call('PUT', `/v1/settings/people/${SAM}/approver`, 'riley-aal2', {
      approverId: CASEY,
    });
    expect(passed.status).toBe(200);
    expect(audit).toEqual([`approver:${SAM}:${CASEY}`]);
  });

  it('leaves People exactly as it was while approval is off, and answers 404 feature_off', async () => {
    const { call, audit } = setup('team.invites=on', [casey]);
    const listed = await call('GET', '/v1/settings/people', 'riley');
    expect(listed.status).toBe(200);
    for (const person of listed.body.people as Listed)
      expect(person).not.toHaveProperty('approver');
    const changed = await call('PATCH', `/v1/settings/people/${SAM}`, 'riley', {
      role: 'approver',
    });
    expect(changed.body).not.toHaveProperty('approver');
    for (const flags of ['team.invites=on', 'reports.approval=on']) {
      const res = await setup(flags, [casey]).call(
        'PUT',
        `/v1/settings/people/${SAM}/approver`,
        'riley',
        { approverId: CASEY },
      );
      expect(res, flags).toMatchObject({ status: 404, body: { code: 'feature_off' } });
    }
    expect(audit).toEqual([`role:${SAM}:approver`]);
  });
});

describe('opening an invite link (#29)', () => {
  it('shows the organization and role it offers, and where the person stands', async () => {
    const { call, offer } = setup();
    offer({ standing: 'empty' });
    const res = await call('POST', '/v1/invites/look-up', 'newcomer', { token: TOKEN });
    expect(res).toMatchObject({
      status: 200,
      body: {
        organization: { id: ORG, name: 'Acme' },
        role: 'approver',
        state: 'pending',
        standing: 'empty',
      },
    });
    const wrong = await call('POST', '/v1/invites/look-up', 'newcomer', { token: 'B'.repeat(43) });
    expect(wrong).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const malformed = await call('POST', '/v1/invites/look-up', 'newcomer', { token: 'short' });
    expect(malformed.status).toBe(400);
    expect((await call('POST', '/v1/invites/look-up', undefined, { token: TOKEN })).status).toBe(
      401,
    );
  });

  it('joins the signed-in person with its role', async () => {
    const { call, offer, answer } = setup();
    offer({});
    answer({
      status: 'joined',
      membership: { orgId: ORG, memberId: SAM, role: 'approver' },
      organizationName: 'Acme',
    });
    const res = await call('POST', '/v1/invites/accept', 'newcomer', { token: TOKEN });
    expect(res).toEqual({
      status: 200,
      body: { organization: { id: ORG, name: 'Acme' }, member: { id: SAM, role: 'approver' } },
    });
  });

  it('says why it can’t join: used, expired, revoked, already in, or work of their own', async () => {
    const { call, offer, answer } = setup();
    offer({});
    const cases: [AcceptInviteResult, number, string][] = [
      [{ status: 'used' }, 410, 'invite_used'],
      [{ status: 'expired' }, 410, 'invite_expired'],
      [{ status: 'revoked' }, 410, 'invite_revoked'],
      [
        { status: 'already_member', membership: { orgId: ORG, memberId: SAM, role: 'member' } },
        409,
        'already_member',
      ],
      [{ status: 'has_own_organization' }, 409, 'has_own_organization'],
    ];
    for (const [result, status, code] of cases) {
      answer(result);
      const res = await call('POST', '/v1/invites/accept', 'newcomer', { token: TOKEN });
      expect(res, code).toMatchObject({ status, body: { code } });
    }
  });

  it('needs an account with an email address to join', async () => {
    const { call, offer, audit } = setup();
    offer({});
    const res = await call('POST', '/v1/invites/accept', 'noemail', { token: TOKEN });
    expect(res).toMatchObject({ status: 422, body: { code: 'email_required' } });
    expect(audit).toEqual([]);
  });
});
