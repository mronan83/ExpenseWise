import { eq, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { aiProvider, aiProviderKeys, type aiAuthScheme } from './schema.ts';

export const AI_PROVIDERS = aiProvider.enumValues;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type AiAuthScheme = (typeof aiAuthScheme.enumValues)[number];

export interface StoredProviderKey {
  readonly provider: AiProvider;
  readonly ciphertext: string;
  readonly keyHint: string;
  readonly authScheme: AiAuthScheme;
  readonly verifiedAt: Date | null;
  readonly updatedAt: Date;
}

const columns = {
  provider: aiProviderKeys.provider,
  ciphertext: aiProviderKeys.ciphertext,
  keyHint: aiProviderKeys.keyHint,
  authScheme: aiProviderKeys.authScheme,
  verifiedAt: aiProviderKeys.verifiedAt,
  updatedAt: aiProviderKeys.updatedAt,
};

/** The organization's provider keys (ciphertext only). Call inside withOrg(). */
export function listProviderKeys(tx: Transaction): Promise<StoredProviderKey[]> {
  return tx.select(columns).from(aiProviderKeys).orderBy(aiProviderKeys.provider);
}

export async function getProviderKey(
  tx: Transaction,
  provider: AiProvider,
): Promise<StoredProviderKey | undefined> {
  const [row] = await tx
    .select(columns)
    .from(aiProviderKeys)
    .where(eq(aiProviderKeys.provider, provider));
  return row;
}

export interface ProviderKeyWrite {
  readonly provider: AiProvider;
  readonly ciphertext: string;
  readonly keyHint: string;
  readonly authScheme: AiAuthScheme;
  readonly verifiedAt: Date;
  readonly memberId: string;
}

/** Saves the key for a provider, replacing any earlier one. Call inside withOrg(). */
export async function saveProviderKey(
  tx: Transaction,
  orgId: string,
  key: ProviderKeyWrite,
): Promise<StoredProviderKey> {
  const values = {
    ciphertext: key.ciphertext,
    keyHint: key.keyHint,
    authScheme: key.authScheme,
    verifiedAt: key.verifiedAt,
    updatedByMemberId: key.memberId,
    updatedAt: sql`now()`,
  };
  const [row] = await tx
    .insert(aiProviderKeys)
    .values({ orgId, provider: key.provider, ...values })
    .onConflictDoUpdate({ target: [aiProviderKeys.orgId, aiProviderKeys.provider], set: values })
    .returning(columns);
  if (!row) throw new Error('saving the provider key returned no row');
  return row;
}

export async function markProviderKeyVerified(
  tx: Transaction,
  provider: AiProvider,
  at: Date,
): Promise<void> {
  await tx
    .update(aiProviderKeys)
    .set({ verifiedAt: at })
    .where(eq(aiProviderKeys.provider, provider));
}

/** Removes the provider's key. Returns false when there was none. */
export async function deleteProviderKey(tx: Transaction, provider: AiProvider): Promise<boolean> {
  const removed = await tx
    .delete(aiProviderKeys)
    .where(eq(aiProviderKeys.provider, provider))
    .returning({ id: aiProviderKeys.id });
  return removed.length > 0;
}
