import {
  getCardStatement,
  getOrganization,
  settleCardStatement,
  type Database,
} from '@expensewise/db';
import { isCurrencyCode } from '@expensewise/domain';
import {
  anthropicClient,
  StatementReader,
  type ModelProvider,
  type StoredAnthropicKey,
} from '@expensewise/extraction';
import type { ObjectStore } from '@expensewise/storage';
import { STATEMENT_MODEL, type StatementReadingPorts } from './card-statements.ts';
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
}

/**
 * The statement workflow on Postgres, Supabase Storage and Anthropic. The model call gets one
 * attempt that ends inside the step's limit, as a receipt's does; the step retries instead.
 */
export function cardStatementReadingPorts(deps: StatementReadingDeps): StatementReadingPorts {
  const { inOrg } = checkedDatabase(deps.db);
  return {
    loadStatement: (orgId, statementId) => inOrg(orgId, (tx) => getCardStatement(tx, statementId)),
    fetchFile: (storageKey) => deps.files.download(storageKey),
    async reader(orgId) {
      const key = await deps.providerKey(orgId, 'anthropic');
      if (typeof key === 'string') return key;
      return new StatementReader(
        anthropicClient(key, { timeoutMs: 50_000, maxRetries: 0 }),
        STATEMENT_MODEL,
      );
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
