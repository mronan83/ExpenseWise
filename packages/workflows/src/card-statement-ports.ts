import {
  getCardStatement,
  getModelSettings,
  getOrganization,
  listProviderKeys,
  settleCardStatement,
  type Database,
} from '@expensewise/db';
import { isCurrencyCode } from '@expensewise/domain';
import {
  anthropicClient,
  ClaudeStatementReader,
  isClaudeModelId,
  OpenAIStatementReader,
  type ModelProvider,
  type StoredAnthropicKey,
} from '@expensewise/extraction';
import type { ObjectStore } from '@expensewise/storage';
import type { StatementReadingPorts } from './card-statements.ts';
import { featureOn } from './features.ts';
import { modelOrderFor } from './reading-plan.ts';
import { checkedDatabase } from './receipt-ports.ts';
import type { KeyProblem } from './receipts.ts';

export interface StatementReadingDeps {
  /** As expensewise_app: every read and write is scoped to the event's organization. */
  readonly db: Database;
  readonly files: ObjectStore;
  /** The organization's key for a provider, decrypted (ADR-0015), or why there is none. */
  readonly providerKey: (
    orgId: string,
    provider: ModelProvider,
  ) => Promise<StoredAnthropicKey | KeyProblem>;
  /** FLAG_OVERRIDES, read from the environment when not given: the operator's stops. */
  readonly flagOverrides?: string;
}

/**
 * The statement workflow on Postgres, Supabase Storage, Anthropic and OpenAI, reading with the
 * organization's AI model settings as receipts do (FR-INT-16, ADR-0050). Each model call gets
 * one attempt that ends inside the step's limit, as a receipt's does; the step retries instead.
 */
export function cardStatementReadingPorts(deps: StatementReadingDeps): StatementReadingPorts {
  const { inOrg } = checkedDatabase(deps.db);
  const overrides = () => deps.flagOverrides ?? process.env.FLAG_OVERRIDES;
  return {
    loadStatement: (orgId, statementId) => inOrg(orgId, (tx) => getCardStatement(tx, statementId)),
    fetchFile: (storageKey) => deps.files.download(storageKey),
    readingOrder: (orgId) =>
      inOrg(orgId, async (tx) => {
        const settingsOn = await featureOn(tx, orgId, 'receipts.model-settings', overrides());
        const keyed = new Set((await listProviderKeys(tx)).map((k) => k.provider));
        const saved = settingsOn ? await getModelSettings(tx) : undefined;
        return modelOrderFor({ settingsOn, saved, keyed, overrides: overrides() });
      }),
    async reader(orgId, model) {
      if (isClaudeModelId(model)) {
        const key = await deps.providerKey(orgId, 'anthropic');
        if (typeof key === 'string') return key;
        return new ClaudeStatementReader(
          anthropicClient(key, { timeoutMs: 50_000, maxRetries: 0 }),
          model,
        );
      }
      const key = await deps.providerKey(orgId, 'openai');
      if (typeof key === 'string') return key;
      return new OpenAIStatementReader(key.key, model, { timeoutMs: 50_000 });
    },
    homeCurrency: (orgId) =>
      inOrg(orgId, async (tx) => {
        const home = (await getOrganization(tx, orgId))?.homeCurrency;
        return home && isCurrencyCode(home) ? home : 'USD';
      }),
    settle: (orgId, statementId, reading) =>
      inOrg(orgId, (tx) => settleCardStatement(tx, orgId, statementId, reading)),
  };
}
