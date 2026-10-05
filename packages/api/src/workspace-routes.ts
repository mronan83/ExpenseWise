import {
  AI_PROVIDERS,
  type AiProvider,
  type Membership,
  type SignIn,
  type StoredProviderKey,
} from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  isPlausibleKey,
  normalizeProviderKey,
  type ProviderKeyVerifier,
  type ProviderVerdict,
} from './ai-providers.ts';
import {
  AuthError,
  requireIdentity,
  type AuthVariables,
  type Identity,
  type TokenVerifier,
} from './auth.ts';
import { featureGate, featureState, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { sealContext } from './provider-keys.ts';
import {
  requireAdminSecondFactor,
  requireCodeToLink,
  requireSecondFactor,
  SECOND_FACTOR_FLAG,
} from './second-factor.ts';
import {
  deleteAiKeyRoute,
  ensureWorkspaceRoute,
  listAiKeysRoute,
  listFeaturesRoute,
  setAiKeyRoute,
  switchFeatureRoute,
  testAiKeyRoute,
} from './routes/workspace.ts';
import { linkSignInRoute, listSignInsRoute, unlinkSignInRoute } from './routes/sign-ins.ts';
import { keyHint, SecretBoxError, type SecretBox } from './secret-box.ts';
import type { CallerMembership, WorkspaceStore } from './workspace.ts';

export interface WorkspaceRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly secrets?: SecretBox;
  readonly verifyProviderKey?: ProviderKeyVerifier;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  readonly now?: () => Date;
}

/** Admin actions: keys can spend the organization's money with the provider. */
const MANAGER_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

const PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

type FailedVerdict = Extract<ProviderVerdict, { ok: false }>;

/** "Anthropic answered 400: <its message>", or why there was no answer. */
function answerText(name: string, verdict: FailedVerdict): string {
  if (!verdict.status) return `No answer from ${name}: ${verdict.detail ?? 'the request failed'}`;
  return `${name} answered ${verdict.status}${verdict.detail ? `: ${verdict.detail}` : ''}`;
}

/** A failed check as a problem document that says what the provider actually answered. */
function verdictProblem(name: string, verdict: FailedVerdict): ProblemError {
  const answered = `${answerText(name, verdict)}. Nothing was stored.`;
  if (verdict.reason === 'rejected') {
    return new ProblemError(422, 'key-rejected', `${name} rejected this key`, {
      code: 'key_rejected',
      detail: answered,
    });
  }
  if (verdict.reason === 'refused') {
    return new ProblemError(422, 'key-refused', `${name} refused the check`, {
      code: 'key_refused',
      detail: answered,
    });
  }
  return new ProblemError(
    502,
    'provider-unreachable',
    verdict.status ? `${name} is busy or having trouble` : `${name} could not be reached`,
    { code: 'provider_unreachable', detail: `${answered} Try again shortly.` },
  );
}

export function keyStatus(provider: AiProvider, stored: StoredProviderKey | undefined) {
  return {
    provider,
    configured: stored !== undefined,
    keyHint: stored?.keyHint ?? null,
    authScheme: stored?.authScheme ?? null,
    verifiedAt: stored?.verifiedAt?.toISOString() ?? null,
    updatedAt: stored?.updatedAt.toISOString() ?? null,
  };
}

/** How recent the other sign-in's token must be to link it: it should come from signing in now. */
const LINK_TOKEN_MAX_AGE_MS = 10 * 60 * 1000;

const signInView = (signIn: SignIn, caller: Identity) => ({
  id: signIn.id,
  email: signIn.email,
  linkedAt: signIn.createdAt.toISOString(),
  current: signIn.userId === caller.userId,
});

export function registerWorkspaceRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: WorkspaceRouteOptions,
) {
  const now = options.now ?? (() => new Date());
  const features = options.features ?? featureGate({ workspace: options.workspace });
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      ensureWorkspaceRoute,
      listAiKeysRoute,
      setAiKeyRoute,
      testAiKeyRoute,
      deleteAiKeyRoute,
      listSignInsRoute,
      linkSignInRoute,
      unlinkSignInRoute,
      listFeaturesRoute,
      switchFeatureRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const store = (): WorkspaceStore => {
    if (!options.workspace) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        {
          code: 'database_not_configured',
        },
      );
    }
    return options.workspace;
  };
  const keyTools = () => {
    if (!options.secrets || !options.verifyProviderKey) {
      throw new ProblemError(
        503,
        'encryption-not-configured',
        'Key storage is not configured on this server',
        {
          code: 'encryption_not_configured',
        },
      );
    }
    return { secrets: options.secrets, verify: options.verifyProviderKey };
  };
  const notStored = (provider: AiProvider) =>
    new ProblemError(404, 'not-found', `No ${PROVIDER_NAMES[provider]} key is stored`, {
      code: 'not_configured',
    });

  /** The caller's membership. */
  const member = async (userId: string): Promise<CallerMembership> => {
    const membership = await store().findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        {
          code: 'no_organization',
          detail: 'Call POST /v1/me/organization after signing in.',
        },
      );
    }
    return membership;
  };

  /** The caller's membership, when they may manage keys. */
  const manager = async (userId: string): Promise<Membership> => {
    const membership = await member(userId);
    if (!MANAGER_ROLES.has(membership.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
      });
    }
    return membership;
  };

  /** The caller, when they may change keys: a manager, past the second factor when it is on. */
  const admin = async (identity: Identity): Promise<Membership> => {
    const membership = await manager(identity.userId);
    await requireAdminSecondFactor(features, membership.orgId, identity);
    return membership;
  };

  app.openapi(ensureWorkspaceRoute, async (c) => {
    const { userId, email } = c.var.identity;
    if (!email) {
      throw new ProblemError(422, 'email-required', 'This account has no email address', {
        code: 'email_required',
      });
    }
    const result = await store().ensureOrganization({ userId, email });
    const body = {
      organization: result.organization,
      member: { id: result.membership.memberId, role: result.membership.role },
    };
    return result.created ? c.json(body, 201) : c.json(body, 200);
  });

  app.openapi(listAiKeysRoute, async (c) => {
    const who = await manager(c.var.identity.userId);
    const keys = await store().listKeys(who.orgId);
    const providers = AI_PROVIDERS.map((p) =>
      keyStatus(
        p,
        keys.find((k) => k.provider === p),
      ),
    );
    return c.json({ providers }, 200);
  });

  app.openapi(setAiKeyRoute, async (c) => {
    const who = await admin(c.var.identity);
    const { secrets, verify } = keyTools();
    const { provider } = c.req.valid('param');
    const apiKey = normalizeProviderKey(c.req.valid('json').apiKey);
    const name = PROVIDER_NAMES[provider];
    if (!isPlausibleKey(apiKey)) {
      throw new ProblemError(422, 'key-malformed', `That doesn't look like a ${name} key`, {
        code: 'key_malformed',
        detail:
          'It is too short or has characters keys never contain. Copy it again from the ' +
          `${name} console and paste only the key. Nothing was stored.`,
      });
    }

    const verdict = await verify(provider, apiKey);
    if (!verdict.ok) {
      // Never the key: the provider's own message and status, for diagnosing from the logs.
      console.warn(
        `Checking a ${provider} key: ${verdict.reason}` +
          `${verdict.status ? ` (${verdict.status})` : ''}${verdict.detail ? `: ${verdict.detail}` : ''}`,
      );
      throw verdictProblem(name, verdict);
    }
    const saved = await store().saveKey(
      who.orgId,
      {
        provider,
        ciphertext: secrets.seal(apiKey, sealContext(who.orgId, provider)),
        keyHint: keyHint(apiKey),
        authScheme: verdict.authScheme,
        verifiedAt: now(),
        memberId: who.memberId,
      },
      c.var.identity.userId,
    );
    return c.json(keyStatus(provider, saved), 200);
  });

  app.openapi(testAiKeyRoute, async (c) => {
    const who = await admin(c.var.identity);
    const { secrets, verify } = keyTools();
    const { provider } = c.req.valid('param');
    const keys = store();
    const stored = await keys.getKey(who.orgId, provider);
    if (!stored) throw notStored(provider);
    let key: string;
    try {
      key = secrets.open(stored.ciphertext, sealContext(who.orgId, provider));
    } catch (error) {
      if (!(error instanceof SecretBoxError)) throw error;
      // The encryption secret changed since the key was saved: it must be entered again.
      return c.json(
        { valid: false, reason: 'unreadable' as const, status: keyStatus(provider, stored) },
        200,
      );
    }
    const verdict = await verify(provider, key, stored.authScheme);
    if (!verdict.ok) {
      return c.json(
        {
          valid: false,
          reason: verdict.reason,
          ...(verdict.detail || verdict.status
            ? { detail: answerText(PROVIDER_NAMES[provider], verdict) }
            : {}),
          status: keyStatus(provider, stored),
        },
        200,
      );
    }
    const at = now();
    if (verdict.authScheme === stored.authScheme) {
      await keys.markVerified(who.orgId, provider, at, c.var.identity.userId);
      return c.json(
        { valid: true, status: keyStatus(provider, { ...stored, verifiedAt: at }) },
        200,
      );
    }
    const resaved = await keys.saveKey(
      who.orgId,
      {
        provider,
        ciphertext: stored.ciphertext,
        keyHint: stored.keyHint,
        authScheme: verdict.authScheme,
        verifiedAt: at,
        memberId: who.memberId,
      },
      c.var.identity.userId,
    );
    return c.json({ valid: true, status: keyStatus(provider, resaved) }, 200);
  });

  app.openapi(deleteAiKeyRoute, async (c) => {
    const who = await admin(c.var.identity);
    const { provider } = c.req.valid('param');
    const removed = await store().deleteKey(who.orgId, provider, c.var.identity.userId);
    if (!removed) throw notStored(provider);
    return c.body(null, 204);
  });

  app.openapi(listSignInsRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const signIns = await store().listSignIns(who);
    return c.json({ signIns: signIns.map((s) => signInView(s, caller)) }, 200);
  });

  app.openapi(linkSignInRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    // Before the other sign-in is even looked at, whatever the switch (#85).
    requireCodeToLink(who, caller);
    const { accessToken } = c.req.valid('json');
    const invalid = (code: string, title: string, detail: string) =>
      new ProblemError(422, code.replaceAll('_', '-'), title, { code, detail });

    let other: Identity;
    try {
      // requireIdentity ran, so a verifier exists.
      other = await options.verifyToken!(accessToken);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      throw invalid(
        'invalid_sign_in',
        'That sign-in could not be confirmed',
        'Sign in with the other email again, then link it.',
      );
    }
    if (other.userId === caller.userId) {
      throw invalid(
        'same_sign_in',
        'That is the sign-in you are using',
        'Sign in with your other email address.',
      );
    }
    if (!other.issuedAt || now().getTime() - other.issuedAt.getTime() > LINK_TOKEN_MAX_AGE_MS) {
      throw invalid(
        'stale_sign_in',
        'That sign-in is too old to link',
        'Sign in with the other email again, then link it.',
      );
    }
    if (!other.email) {
      throw invalid(
        'email_required',
        'That account has no email address',
        'Only email sign-ins can be linked.',
      );
    }

    const result = await store().linkSignIn(
      who,
      { userId: other.userId, email: other.email },
      caller.userId,
    );
    switch (result.status) {
      case 'linked':
        return c.json(signInView(result.signIn, caller), 201);
      case 'already_linked':
        return c.json(signInView(result.signIn, caller), 200);
      case 'other_member':
        throw new ProblemError(409, 'sign-in-in-use', 'That sign-in belongs to someone else here', {
          code: 'sign_in_in_use',
        });
      case 'has_own_organization':
        throw new ProblemError(
          409,
          'sign-in-has-organization',
          'That sign-in already has its own receipts or settings',
          {
            code: 'sign_in_has_organization',
            detail:
              'Nothing was changed. Sign in with that email instead and link this one to it, ' +
              'so its work stays where it is.',
          },
        );
    }
  });

  app.openapi(unlinkSignInRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { signInId } = c.req.valid('param');
    const keys = store();
    const target = (await keys.listSignIns(who)).find((s) => s.id === signInId);
    const notFound = () =>
      new ProblemError(404, 'not-found', 'You have no such sign-in', { code: 'not_found' });
    if (!target) throw notFound();
    if (target.userId === caller.userId) {
      throw new ProblemError(
        409,
        'current-sign-in',
        'You cannot remove the sign-in you are using',
        {
          code: 'current_sign_in',
          detail: 'Sign in with another of your emails to remove this one.',
        },
      );
    }
    const outcome = await keys.unlinkSignIn(who, signInId, caller.userId);
    if (outcome === 'not_found') throw notFound();
    // 'last' cannot happen here: the caller's own sign-in remains.
    return c.body(null, 204);
  });

  app.openapi(listFeaturesRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const list = await features.list(who.orgId);
    return c.json({ features: list, canSwitch: who.role === 'owner' }, 200);
  });

  app.openapi(switchFeatureRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    if (who.role !== 'owner') {
      throw new ProblemError(403, 'forbidden', 'Only the owner can switch features', {
        code: 'forbidden_role',
      });
    }
    await requireAdminSecondFactor(features, who.orgId, caller);
    const { key } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    if (features.overridden(key)) {
      throw new ProblemError(409, 'feature-overridden', 'This feature is set on the server', {
        code: 'feature_overridden',
        detail:
          'FLAG_OVERRIDES on the server decides it, so a switch here would have no effect. ' +
          'Remove it from FLAG_OVERRIDES first.',
      });
    }
    if (key === SECOND_FACTOR_FLAG && enabled) {
      // No lockout: only an owner who has enrolled and passed it can ask it of everyone.
      requireSecondFactor(
        caller,
        'Switching the second factor on needs your own first, so no one is locked out: add an ' +
          'authenticator app in Settings › Sign-ins and enter its code, then switch it on.',
      );
    }
    await store().switchFeature(who, { flag: key, enabled }, caller.userId);
    const switched = (await store().listFeatures(who.orgId)).find((f) => f.flag === key);
    return c.json(featureState(key, undefined, switched), 200);
  });
}
