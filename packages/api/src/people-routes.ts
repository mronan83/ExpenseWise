import type { ApproverRouting, InviteRecord, Membership, PersonRecord } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { APPROVAL_FEATURE } from './approval-routes.ts';
import { requireIdentity, type AuthVariables, type Identity, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate, type OrgFeatureKey } from './features.ts';
import type { PeopleStore } from './people.ts';
import { ProblemError } from './problem.ts';
import { requireAdminSecondFactor } from './second-factor.ts';
import {
  acceptInviteRoute,
  changeRoleRoute,
  chooseApproverRoute,
  createInviteRoute,
  listPeopleRoute,
  lookUpInviteRoute,
  removePersonRoute,
  revokeInviteRoute,
} from './routes/people.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface PeopleRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly people?: PeopleStore;
  readonly features?: FeatureGate;
  readonly flagOverrides?: string;
  readonly now?: () => Date;
}

const FLAG = 'team.invites';

const personView = (p: PersonRecord, caller: Membership) => ({
  id: p.memberId,
  name: p.displayName,
  email: p.email,
  role: p.role,
  joinedAt: p.joinedAt.toISOString(),
  removedAt: p.removedAt?.toISOString() ?? null,
  you: p.memberId === caller.memberId,
});

/** Who approves someone's reports (#86), each person named as People lists them. */
const approverView = (r: ApproverRouting, people: readonly PersonRecord[]) => {
  const ref = (id: string) => ({
    id,
    name: people.find((p) => p.memberId === id)?.displayName ?? '',
  });
  return {
    chosen: r.chosenMemberId === null ? null : ref(r.chosenMemberId),
    goesTo: r.goesToMemberId === null ? null : ref(r.goesToMemberId),
    passedOver: r.passedOver,
    choices: r.choices.map(ref),
  };
};

const inviteView = (i: InviteRecord, now: Date) => ({
  id: i.id,
  role: i.role,
  label: i.label,
  createdBy: i.createdBy,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
  expired: now.getTime() >= i.expiresAt.getTime(),
});

/**
 * Settings › People and invite links (FR-PLT-07, #29, ADR-0035), behind team.invites. Only an
 * owner manages people; anyone signed in can open a link they were given.
 */
export function registerPeopleRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: PeopleRouteOptions,
) {
  const now = options.now ?? (() => new Date());
  const features = options.features ?? featureGate(options);
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      listPeopleRoute,
      createInviteRoute,
      revokeInviteRoute,
      changeRoleRoute,
      chooseApproverRoute,
      removePersonRoute,
      lookUpInviteRoute,
      acceptInviteRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.people) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, people: options.people };
  };

  /**
   * The caller, when they are an owner and the feature is on in their organization, with any
   * other feature the action also needs.
   */
  const owner = async (userId: string, also?: OrgFeatureKey): Promise<Membership> => {
    const who = await stores().workspace.findMembership(userId);
    if (!who) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    await features.require(who.orgId, FLAG);
    if (also) await features.require(who.orgId, also);
    if (who.role !== 'owner') {
      throw new ProblemError(403, 'forbidden', 'Only an owner can manage people', {
        code: 'forbidden_role',
      });
    }
    return who;
  };
  /** An owner changing people or links, past the second factor while it is on (FR-GOV-04). */
  const ownerActing = async (identity: Identity, also?: OrgFeatureKey): Promise<Membership> => {
    const who = await owner(identity.userId, also);
    await requireAdminSecondFactor(features, who.orgId, identity);
    return who;
  };
  /**
   * Everyone, as People shows them: while approval is on, with who approves each active
   * person's reports (#86); off, exactly as before.
   */
  const everyone = async (who: Membership) => {
    const { people } = stores();
    const listed = await people.list(who.orgId);
    const routing = (await features.isOn(who.orgId, APPROVAL_FEATURE))
      ? await people.approvers(who.orgId)
      : [];
    return {
      ...listed,
      views: listed.people.map((p) => {
        const route = routing.find((r) => r.memberId === p.memberId);
        return route
          ? { ...personView(p, who), approver: approverView(route, listed.people) }
          : personView(p, who);
      }),
    };
  };
  const noSuchPerson = () =>
    new ProblemError(404, 'not-found', 'No such person here', { code: 'not_found' });
  const lastOwner = () =>
    new ProblemError(409, 'last-owner', 'The organization needs an owner', {
      code: 'last_owner',
      detail: 'Make someone else an owner first.',
    });

  app.openapi(listPeopleRoute, async (c) => {
    const who = await owner(c.var.identity.userId);
    const { views, invites } = await everyone(who);
    const at = now();
    return c.json({ people: views, invites: invites.map((i) => inviteView(i, at)) }, 200);
  });

  app.openapi(createInviteRoute, async (c) => {
    const who = await ownerActing(c.var.identity);
    const { role, label } = c.req.valid('json');
    const at = now();
    const { invite, token } = await stores().people.invite(
      who,
      { role, label: label?.trim() || null },
      c.var.identity.userId,
      at,
    );
    return c.json({ invite: inviteView(invite, at), token, path: `/invite/${token}` }, 201);
  });

  app.openapi(revokeInviteRoute, async (c) => {
    const who = await ownerActing(c.var.identity);
    const { inviteId } = c.req.valid('param');
    const result = await stores().people.revokeInvite(
      who.orgId,
      inviteId,
      c.var.identity.userId,
      now(),
    );
    if (result === 'missing') {
      throw new ProblemError(404, 'not-found', 'No such invite', { code: 'not_found' });
    }
    if (result === 'accepted') {
      throw new ProblemError(409, 'invite-used', 'This invite was already used', {
        code: 'invite_used',
        detail: 'To take someone out again, remove them from People.',
      });
    }
    return c.body(null, 204);
  });

  app.openapi(changeRoleRoute, async (c) => {
    const who = await ownerActing(c.var.identity);
    const { memberId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    const { people } = stores();
    const result = await people.changeRole(who.orgId, memberId, role, c.var.identity.userId);
    if (result === 'missing') throw noSuchPerson();
    if (result === 'last_owner') throw lastOwner();
    const person = (await everyone(who)).views.find((p) => p.id === memberId);
    if (!person) throw noSuchPerson();
    return c.json(person, 200);
  });

  app.openapi(chooseApproverRoute, async (c) => {
    const who = await ownerActing(c.var.identity, APPROVAL_FEATURE);
    const { memberId } = c.req.valid('param');
    const { approverId } = c.req.valid('json');
    const result = await stores().people.chooseApprover(
      who.orgId,
      memberId,
      approverId,
      c.var.identity.userId,
    );
    if (result === 'missing') throw noSuchPerson();
    if (result === 'own_approver') {
      throw new ProblemError(422, 'own-approver', 'No one approves their own reports', {
        code: 'own_approver',
        detail: 'Choose someone else, or Automatic.',
      });
    }
    if (result === 'not_an_approver') {
      throw new ProblemError(422, 'not-an-approver', 'They can’t approve reports', {
        code: 'not_an_approver',
        detail: 'Choose someone here who is an approver, finance admin or owner.',
      });
    }
    const person = (await everyone(who)).views.find((p) => p.id === memberId);
    if (!person) throw noSuchPerson();
    return c.json(person, 200);
  });

  app.openapi(removePersonRoute, async (c) => {
    const who = await ownerActing(c.var.identity);
    const { memberId } = c.req.valid('param');
    if (memberId === who.memberId) {
      throw new ProblemError(409, 'cannot-remove-self', 'You can’t remove yourself', {
        code: 'cannot_remove_self',
        detail: 'Another owner can remove you.',
      });
    }
    const result = await stores().people.remove(who.orgId, memberId, c.var.identity.userId, now());
    if (result === 'missing') throw noSuchPerson();
    if (result === 'last_owner') throw lastOwner();
    return c.body(null, 204);
  });

  const noInvite = () =>
    new ProblemError(404, 'not-found', 'This invite link doesn’t work', {
      code: 'not_found',
      detail: 'Check you copied the whole link, or ask for a new one.',
    });
  /**
   * Whoever holds a link may not belong anywhere yet, so nothing here needs their membership;
   * it is still resolved, as every route's caller is, so the organization they are in now, if
   * any, asks for the code of someone with an authenticator first (#85).
   */
  const admit = async (userId: string) => {
    await stores().workspace.findMembership(userId);
  };

  app.openapi(lookUpInviteRoute, async (c) => {
    const { token } = c.req.valid('json');
    await admit(c.var.identity.userId);
    const found = await stores().people.lookUp(token, c.var.identity.userId, now());
    if (!found) throw noInvite();
    await features.require(found.orgId, FLAG);
    return c.json(
      {
        organization: { id: found.orgId, name: found.organizationName },
        role: found.role,
        expiresAt: found.expiresAt.toISOString(),
        state: found.state,
        standing: found.standing,
      },
      200,
    );
  });

  app.openapi(acceptInviteRoute, async (c) => {
    const { userId, email } = c.var.identity;
    const { token } = c.req.valid('json');
    const { people } = stores();
    await admit(userId);
    const found = await people.lookUp(token, userId, now());
    if (!found) throw noInvite();
    await features.require(found.orgId, FLAG);
    if (!email) {
      throw new ProblemError(422, 'email-required', 'This account has no email address', {
        code: 'email_required',
      });
    }
    const result = await people.accept(token, { userId, email }, now());
    const gone = (code: string, title: string) =>
      new ProblemError(410, code.replaceAll('_', '-'), title, {
        code,
        detail: 'Ask the organization’s owner for a new link.',
      });
    switch (result.status) {
      case 'joined':
        return c.json(
          {
            organization: { id: result.membership.orgId, name: result.organizationName },
            member: { id: result.membership.memberId, role: result.membership.role },
          },
          200,
        );
      case 'not_found':
        throw noInvite();
      case 'expired':
        throw gone('invite_expired', 'This invite link has expired');
      case 'revoked':
        throw gone('invite_revoked', 'This invite link was revoked');
      case 'used':
        throw gone('invite_used', 'This invite link was already used');
      case 'already_member':
        throw new ProblemError(409, 'already-member', 'You are already in this organization', {
          code: 'already_member',
        });
      case 'has_own_organization':
        throw new ProblemError(
          409,
          'has-own-organization',
          'You already have receipts, settings or people in your own organization',
          {
            code: 'has_own_organization',
            detail:
              'Nothing was changed: joining would leave them behind. Ask the owner to invite ' +
              'another email of yours instead.',
          },
        );
    }
  });
}
