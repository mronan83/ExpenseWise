import {
  getProviderKey,
  withOrg,
  type AiProvider,
  type AiAuthScheme,
  type Database,
} from '@expensewise/db';
import { SecretBoxError, type SecretBox } from './secret-box.ts';

/** Binds a ciphertext to its organization and provider (ADR-0015). */
export const sealContext = (orgId: string, provider: AiProvider) => `${orgId}:${provider}`;

export type StoredKeyProblem = 'no_key' | 'unreadable_key';

/**
 * Reads an organization's stored provider key for server-side use, such as the receipt
 * workflow. The plaintext stays in memory for the call that needs it; it is never logged.
 */
export function storedKeyReader(db: Database, secrets: SecretBox) {
  return async (
    orgId: string,
    provider: AiProvider,
  ): Promise<{ key: string; authScheme: AiAuthScheme } | StoredKeyProblem> => {
    const stored = await withOrg(db, orgId, (tx) => getProviderKey(tx, provider));
    if (!stored) return 'no_key';
    try {
      return {
        key: secrets.open(stored.ciphertext, sealContext(orgId, provider)),
        authScheme: stored.authScheme,
      };
    } catch (error) {
      if (error instanceof SecretBoxError) return 'unreadable_key';
      throw error;
    }
  };
}
