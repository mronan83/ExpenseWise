import {
  assertRowSecurityApplies,
  getModelSettings,
  saveModelSettings,
  withOrg,
  type AiProvider,
  type Database,
  type ExtractionRunRecord,
  type Membership,
  type ModelSwitch,
  type ReceiptRecord,
  type StoredModelSettings,
} from '@expensewise/db';
import {
  formatUsd,
  MODELS,
  modelSettingsFrom,
  readingOrder,
  SETTINGS_MODELS,
  type ModelId,
  type ModelSettings,
} from '@expensewise/extraction';
import { modelStopped, parseOverrides } from '@expensewise/flags';
import { comparisonSummary, latestRuns } from './receipt-views.ts';

/**
 * Which AI models read the organization's receipts (FR-INT-16). Saving appends its audit
 * event in the same transaction. Tests use an in-memory fake.
 */
export interface ModelSettingsStore {
  /** The organization's saved choice, or undefined while the defaults apply. */
  get(orgId: string): Promise<StoredModelSettings | undefined>;
  save(
    member: Membership,
    settings: { readonly primary: string | null; readonly models: readonly ModelSwitch[] },
    actorUserId: string,
  ): Promise<'saved' | 'unchanged'>;
}

/** The store on Postgres, as expensewise_app. It checks the role once, before first use. */
export function dbModelSettingsStore(db: Database): ModelSettingsStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return {
    async get(orgId) {
      await safe();
      return withOrg(db, orgId, (tx) => getModelSettings(tx));
    },
    async save(member, settings, actorUserId) {
      await safe();
      return withOrg(db, member.orgId, (tx) =>
        saveModelSettings(tx, member.orgId, settings, member.memberId, actorUserId),
      );
    },
  };
}

/** The models the operator has stopped for every organization, in FLAG_OVERRIDES. */
export function stoppedModels(flagOverrides: string | undefined): ReadonlySet<ModelId> {
  const overrides = parseOverrides(flagOverrides);
  return new Set(SETTINGS_MODELS.filter((model) => modelStopped(model, overrides)));
}

/** What decides which models read an organization's receipts now. */
export interface ModelContext {
  /** As saved, or the defaults, with a model whose provider has no key off: it stays off. */
  readonly settings: ModelSettings;
  readonly saved: StoredModelSettings | undefined;
  readonly keyed: ReadonlySet<AiProvider>;
  readonly stopped: ReadonlySet<ModelId>;
}

export function modelContext(
  saved: StoredModelSettings | undefined,
  keyed: ReadonlySet<AiProvider>,
  stopped: ReadonlySet<ModelId>,
): ModelContext {
  const chosen = modelSettingsFrom(saved);
  const models = chosen.models.map((m) => ({
    model: m.model,
    enabled: m.enabled && keyed.has(MODELS[m.model].provider),
  }));
  // The same rule as for a saved primary that is gone: the first model on takes its place.
  const settings = modelSettingsFrom({ primary: chosen.primary, models });
  return { settings, saved, keyed, stopped };
}

/** The models that read the next receipt, in order: the primary, then the back-ups that can. */
export function readsNext(context: ModelContext): ModelId[] {
  return readingOrder(context.settings).filter((model) => !context.stopped.has(model));
}

/** One model's record on the organization's latest readings: the running comparison. */
function recordOf(model: ModelId, runs: readonly ExtractionRunRecord[]) {
  const mine = runs.filter((r) => r.model === model);
  const read = mine.filter((r) => r.outcome !== 'failed');
  const timed = read.filter((r) => r.latencyMs !== null);
  return {
    readings: mine.length,
    confident: mine.filter((r) => r.outcome === 'confident').length,
    unsure: mine.filter((r) => r.outcome === 'unsure').length,
    failed: mine.length - read.length,
    // Whole milliseconds; an average of durations, not money.
    averageLatencyMs:
      timed.length === 0
        ? null
        : Math.round(timed.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / timed.length),
    costMicroUsd: mine.reduce((sum, r) => sum + (r.costMicroUsd ?? 0), 0),
  };
}

/** List price per million tokens, as a dollar amount: 1000 nano-dollars a token is $1.00. */
const perMillion = (nanoPerToken: bigint) => formatUsd(nanoPerToken * 1_000_000n, 2);

/**
 * Settings › AI models: each model, on or off, which one is primary, what each does now, and
 * how each has read the organization's receipts, so the choice is an informed one (#52).
 */
export function modelSettingsView(
  context: ModelContext,
  receipts: readonly ReceiptRecord[],
  runs: readonly ExtractionRunRecord[],
  canChange: boolean,
) {
  const next = readsNext(context);
  const latest = receipts
    .filter((r) => r.status !== 'processing')
    .flatMap((r) => latestRuns(r.id, runs));
  const { receipts: counted, compared, agreed } = comparisonSummary(receipts, runs);
  return {
    primary: context.settings.primary,
    models: context.settings.models.map(({ model, enabled }) => {
      const { provider, label, tier, price } = MODELS[model];
      const place = next.indexOf(model);
      return {
        model,
        label,
        provider,
        tier,
        price: { input: perMillion(price.input), output: perMillion(price.output) },
        enabled,
        primary: model === context.settings.primary,
        reads:
          place === 0 ? ('primary' as const) : place > 0 ? ('backup' as const) : ('off' as const),
        keyConfigured: context.keyed.has(provider),
        stopped: context.stopped.has(model),
        record: recordOf(model, latest),
      };
    }),
    saved: context.saved !== undefined,
    updatedAt: context.saved?.updatedAt.toISOString() ?? null,
    canChange,
    comparison: { receipts: counted, compared, agreed },
  };
}
