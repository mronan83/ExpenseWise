import {
  AI_PROVIDERS,
  type AiProvider,
  type Membership,
  type StoredProviderKey,
} from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ProviderKeyVerifier } from './ai-providers.ts';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { ProblemError } from './problem.ts';
import {
  deleteAiKeyRoute,
  ensureWorkspaceRoute,
  listAiKeysRoute,
  setAiKeyRoute,
  testAiKeyRoute,
} from './routes/workspace.ts';
import { keyHint, SecretBoxError, type SecretBox } from './secret-box.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface WorkspaceRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly secrets?: SecretBox;
  readonly verifyProviderKey?: ProviderKeyVerifier;
  readonly now?: () => Date;
}

/** Admin actions: keys can spend the organization's money with the provider. */
const MANAGER_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

const PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

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

/** Binds a ciphertext to its organization and provider. */
const sealContext = (orgId: string, provider: AiProvider) => `${orgId}:${provider}`;

export function registerWorkspaceRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: WorkspaceRouteOptions,
) {
  const now = options.now ?? (() => new Date());
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [ensureWorkspaceRoute, listAiKeysRoute, setAiKeyRoute, testAiKeyRoute, deleteAiKeyRoute].map(
      (r) => r.getRoutingPath(),
    ),
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

  /** The caller's membership, when they may manage keys. */
  const manager = async (userId: string): Promise<Membership> => {
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
    if (!MANAGER_ROLES.has(membership.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
      });
    }
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
    const who = await manager(c.var.identity.userId);
    const { secrets, verify } = keyTools();
    const { provider } = c.req.valid('param');
    const { apiKey } = c.req.valid('json');

    const verdict = await verify(provider, apiKey);
    if (!verdict.ok) {
      throw verdict.reason === 'rejected'
        ? new ProblemError(422, 'key-rejected', `${PROVIDER_NAMES[provider]} rejected this key`, {
            code: 'key_rejected',
            detail: `${PROVIDER_NAMES[provider]} answered ${verdict.status ?? 'with an error'} when the key was checked. Nothing was stored.`,
          })
        : new ProblemError(
            502,
            'provider-unreachable',
            `${PROVIDER_NAMES[provider]} could not be reached`,
            {
              code: 'provider_unreachable',
              detail: 'The key could not be checked, so nothing was stored. Try again shortly.',
            },
          );
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
    const who = await manager(c.var.identity.userId);
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
        { valid: false, reason: verdict.reason, status: keyStatus(provider, stored) },
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
    const who = await manager(c.var.identity.userId);
    const { provider } = c.req.valid('param');
    const removed = await store().deleteKey(who.orgId, provider, c.var.identity.userId);
    if (!removed) throw notStored(provider);
    return c.body(null, 204);
  });
}
