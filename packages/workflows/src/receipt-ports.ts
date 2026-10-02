import {
  assertRowSecurityApplies,
  getReceipt,
  recordExtractionRun,
  runsForRequest,
  settleReceipt,
  withOrg,
  type Database,
} from '@expensewise/db';
import { anthropicClient, ClaudeExtractor, type StoredAnthropicKey } from '@expensewise/extraction';
import type { ObjectStore } from '@expensewise/storage';
import type { KeyProblem, ReceiptReadingPorts } from './receipts.ts';

export interface ReceiptReadingDeps {
  /** As expensewise_app: every read and write is scoped to the event's organization. */
  readonly db: Database;
  readonly files: ObjectStore;
  /** The organization's Anthropic key, decrypted (ADR-0015), or why there is none. */
  readonly anthropicKey: (orgId: string) => Promise<StoredAnthropicKey | KeyProblem>;
}

/**
 * The receipt workflow on Postgres, Supabase Storage and Anthropic. Each provider call gets
 * one attempt with a 50-second limit, inside the 60 seconds a step may run; the workflow
 * runner retries the step instead.
 */
export function receiptReadingPorts(deps: ReceiptReadingDeps): ReceiptReadingPorts {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(deps.db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(deps.db, orgId, work);
  };

  return {
    loadReceipt: (orgId, receiptId) => inOrg(orgId, (tx) => getReceipt(tx, receiptId)),
    fetchFile: (storageKey) => deps.files.download(storageKey),
    async extractor(orgId, model) {
      const key = await deps.anthropicKey(orgId);
      if (typeof key === 'string') return key;
      return new ClaudeExtractor(anthropicClient(key, { timeoutMs: 50_000, maxRetries: 0 }), model);
    },
    saveRun: (orgId, run) => inOrg(orgId, (tx) => recordExtractionRun(tx, orgId, run)),
    runs: (orgId, receiptId, requestId) =>
      inOrg(orgId, (tx) => runsForRequest(tx, receiptId, requestId)),
    settle: (orgId, receiptId, outcome) =>
      inOrg(orgId, (tx) => settleReceipt(tx, orgId, receiptId, outcome)),
  };
}
