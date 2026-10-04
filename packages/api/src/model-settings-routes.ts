import type { Membership } from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import { checkModelSettings, MODELS, type ModelSettingsProblem } from '@expensewise/extraction';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import {
  modelContext,
  modelSettingsView,
  stoppedModels,
  type ModelSettingsStore,
} from './model-settings.ts';
import { ProblemError } from './problem.ts';
import type { ReceiptStore } from './receipts.ts';
import { getModelSettingsRoute, saveModelSettingsRoute } from './routes/model-settings.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ModelSettingsRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly receipts?: ReceiptStore;
  readonly modelSettings?: ModelSettingsStore;
  readonly flagOverrides?: string;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

/** Choosing the models spends the organization's money with the providers. */
const CHOOSERS: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

/** How many of the latest receipts the record covers, as Receipts shows the comparison. */
const RECORD_RECEIPTS = 100;

const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

function settingsProblem(problem: ModelSettingsProblem): ProblemError {
  const invalid = (code: string, title: string, detail: string) =>
    new ProblemError(422, code.replaceAll('_', '-'), title, { code, detail });
  switch (problem.kind) {
    case 'unknown_model':
      return invalid('unknown_model', 'No such model', `${problem.model} is not a model here.`);
    case 'listed_twice':
      return invalid(
        'listed_twice',
        'A model is listed twice',
        `${problem.model} is listed twice.`,
      );
    case 'not_listed':
      return invalid(
        'models_missing',
        'Some models are missing',
        `List every model once, in order: ${problem.models.join(', ')} ${
          problem.models.length === 1 ? 'is' : 'are'
        } missing.`,
      );
    case 'primary_off':
      return invalid(
        'primary_off',
        'The primary must be on',
        `Switch ${problem.model} on, or choose a model that is on as primary.`,
      );
    case 'no_primary':
      return invalid(
        'primary_required',
        'Choose a primary',
        'One model that is on reads every receipt. Choose it, or switch every model off.',
      );
  }
}

/** Settings › AI models (FR-INT-16, #52), behind receipts.model-settings. */
export function registerModelSettingsRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ModelSettingsRouteOptions,
) {
  const features = options.features ?? featureGate(options);
  const auth = requireIdentity(options.verifyToken);
  for (const path of new Set(
    [getModelSettingsRoute, saveModelSettingsRoute].map((r) => r.getRoutingPath()),
  )) {
    app.use(path, auth);
  }

  const stores = () => {
    if (!options.workspace || !options.receipts || !options.modelSettings) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return {
      workspace: options.workspace,
      receipts: options.receipts,
      models: options.modelSettings,
    };
  };

  /** The caller's membership, once the feature is on for their organization. */
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    await features.require(membership.orgId, 'receipts.model-settings');
    return membership;
  };

  const view = async (who: Membership) => {
    const { workspace, receipts, models } = stores();
    const [saved, keys, read] = await Promise.all([
      models.get(who.orgId),
      workspace.listKeys(who.orgId),
      receipts.list(who.orgId, RECORD_RECEIPTS),
    ]);
    const context = modelContext(
      saved,
      new Set(keys.map((k) => k.provider)),
      stoppedModels(options.flagOverrides),
    );
    return modelSettingsView(context, read.receipts, read.runs, CHOOSERS.has(who.role));
  };

  app.openapi(getModelSettingsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await view(who), 200);
  });

  app.openapi(saveModelSettingsRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    if (!CHOOSERS.has(who.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
      });
    }
    const checked = checkModelSettings(c.req.valid('json'));
    if (!checked.ok) throw settingsProblem(checked.problem);
    const { workspace, models } = stores();
    // A model with no key stays off: it could read nothing.
    const keyed = new Set((await workspace.listKeys(who.orgId)).map((k) => k.provider));
    const keyless = checked.value.models.find(
      (m) => m.enabled && !keyed.has(MODELS[m.model].provider),
    );
    if (keyless) {
      const { label, provider } = MODELS[keyless.model];
      throw new ProblemError(422, 'no-key', `${label} needs a key`, {
        code: 'no_key',
        detail: `Add a ${PROVIDER_NAMES[provider]} key in Settings › AI providers, then switch ${label} on.`,
      });
    }
    await models.save(who, checked.value, caller.userId);
    return c.json(await view(who), 200);
  });
}
