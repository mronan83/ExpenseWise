import {
  assertRowSecurityApplies,
  getModelSettings,
  getReceipt,
  listProviderKeys,
  recordExtractionRun,
  runsForRequest,
  settleReceipt,
  withOrg,
  type Database,
} from '@expensewise/db';
import {
  anthropicClient,
  ClaudeExtractor,
  isClaudeModelId,
  OpenAIExtractor,
  type ModelProvider,
  type StoredAnthropicKey,
} from '@expensewise/extraction';
import type { ObjectStore } from '@expensewise/storage';
import { featureSwitch } from './features.ts';
import { featureOn } from './features.ts';
import { readingPlanFor } from './reading-plan.ts';
import type { KeyProblem, ReceiptReadingPorts } from './receipts.ts';

/**
 * The database as a workflow uses it: checked once, before the first query, to be a role row
 * security applies to, then each piece of work runs inside one organization.
 */
export function checkedDatabase(db: Database) {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return {
    safe,
    inOrg: async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
      await safe();
      return withOrg(db, orgId, work);
    },
  };
}

export interface ReceiptReadingDeps {
  /** As expensewise_app: every read and write is scoped to the event's organization. */
  readonly db: Database;
  readonly files: ObjectStore;
  /** The organization's key for a provider, decrypted (ADR-0015), or why there is none. */
  readonly providerKey: (
    orgId: string,
    provider: ModelProvider,
  ) => Promise<StoredAnthropicKey | KeyProblem>;
  /** FLAG_OVERRIDES, read from the environment when not given. */
  readonly flagOverrides?: string;
  /** FLAG_OVERRIDES, when not the server's own: the kill switches and operator stops. */
  readonly flagOverrides?: string;
}

/**
 * The receipt workflow on Postgres, Supabase Storage, Anthropic and OpenAI. Each provider
 * call gets one attempt with a 50-second limit, inside the 60 seconds a step may run; the
 * workflow runner retries the step instead.
 */
export function receiptReadingPorts(deps: ReceiptReadingDeps): ReceiptReadingPorts {
  const { inOrg } = checkedDatabase(deps.db);
  const featureOn = featureSwitch(inOrg, deps.flagOverrides ?? process.env.FLAG_OVERRIDES);
  // Where the organization has switched it on, each field comes with the line it was read
  // from (GAP-14); elsewhere the request is the one every reading has always sent.
  const asked = async (orgId: string) => ({
    fieldSources: await featureOn(orgId, 'receipts.field-sources'),
  });

  const overrides = () => deps.flagOverrides ?? process.env.FLAG_OVERRIDES;

  return {
    // Read at the start of every reading, so a change in Settings applies to the next one,
    // read again included (FR-INT-16).
    readingPlan: (orgId) =>
      inOrg(orgId, async (tx) => {
        const settingsOn = await featureOn(tx, orgId, 'receipts.model-settings', overrides());
        if (!settingsOn) return readingPlanFor({ settingsOn, overrides: overrides() });
        const keyed = new Set((await listProviderKeys(tx)).map((k) => k.provider));
        const saved = await getModelSettings(tx);
        return readingPlanFor({ settingsOn, saved, keyed, overrides: overrides() });
      }),
    loadReceipt: (orgId, receiptId) => inOrg(orgId, (tx) => getReceipt(tx, receiptId)),
    fetchFile: (storageKey) => deps.files.download(storageKey),
    async extractor(orgId, model) {
      if (isClaudeModelId(model)) {
        const key = await deps.providerKey(orgId, 'anthropic');
        if (typeof key === 'string') return key;
        const client = anthropicClient(key, { timeoutMs: 50_000, maxRetries: 0 });
        return new ClaudeExtractor(client, model, await asked(orgId));
      }
      const key = await deps.providerKey(orgId, 'openai');
      if (typeof key === 'string') return key;
      return new OpenAIExtractor(key.key, model, { timeoutMs: 50_000, ...(await asked(orgId)) });
    },
    saveRun: (orgId, run) => inOrg(orgId, (tx) => recordExtractionRun(tx, orgId, run)),
    runs: (orgId, receiptId, requestId) =>
      inOrg(orgId, (tx) => runsForRequest(tx, receiptId, requestId)),
    settle: (orgId, receiptId, outcome) =>
      inOrg(orgId, (tx) => settleReceipt(tx, orgId, receiptId, outcome)),
  };
}
