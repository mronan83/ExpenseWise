import {
  assertRowSecurityApplies,
  getReceipt,
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
}

/**
 * The receipt workflow on Postgres, Supabase Storage, Anthropic and OpenAI. Each provider
 * call gets one attempt with a 50-second limit, inside the 60 seconds a step may run; the
 * workflow runner retries the step instead.
 */
export function receiptReadingPorts(deps: ReceiptReadingDeps): ReceiptReadingPorts {
  const { inOrg } = checkedDatabase(deps.db);

  return {
    loadReceipt: (orgId, receiptId) => inOrg(orgId, (tx) => getReceipt(tx, receiptId)),
    fetchFile: (storageKey) => deps.files.download(storageKey),
    async extractor(orgId, model) {
      if (isClaudeModelId(model)) {
        const key = await deps.providerKey(orgId, 'anthropic');
        if (typeof key === 'string') return key;
        const client = anthropicClient(key, { timeoutMs: 50_000, maxRetries: 0 });
        return new ClaudeExtractor(client, model);
      }
      const key = await deps.providerKey(orgId, 'openai');
      if (typeof key === 'string') return key;
      return new OpenAIExtractor(key.key, model, { timeoutMs: 50_000 });
    },
    saveRun: (orgId, run) => inOrg(orgId, (tx) => recordExtractionRun(tx, orgId, run)),
    runs: (orgId, receiptId, requestId) =>
      inOrg(orgId, (tx) => runsForRequest(tx, receiptId, requestId)),
    settle: (orgId, receiptId, outcome) =>
      inOrg(orgId, (tx) => settleReceipt(tx, orgId, receiptId, outcome)),
  };
}
