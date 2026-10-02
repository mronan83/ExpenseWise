import {
  appendAuditEvent,
  assertRowSecurityApplies,
  deleteProviderKey,
  ensureOwnerOrganization,
  findMemberships,
  getProviderKey,
  listProviderKeys,
  markProviderKeyVerified,
  organizations,
  saveProviderKey,
  withOrg,
  type AiProvider,
  type Database,
  type Membership,
  type ProviderKeyWrite,
  type StoredProviderKey,
} from '@expensewise/db';

export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly homeCurrency: string;
}

/**
 * What the API needs from the database for organizations and provider keys. Every write
 * appends its audit event in the same transaction. Tests use an in-memory fake.
 */
export interface WorkspaceStore {
  ensureOrganization(owner: {
    userId: string;
    email: string;
  }): Promise<{ membership: Membership; organization: OrganizationView; created: boolean }>;
  findMembership(userId: string): Promise<Membership | undefined>;
  listKeys(orgId: string): Promise<StoredProviderKey[]>;
  getKey(orgId: string, provider: AiProvider): Promise<StoredProviderKey | undefined>;
  saveKey(orgId: string, key: ProviderKeyWrite, actorUserId: string): Promise<StoredProviderKey>;
  markVerified(orgId: string, provider: AiProvider, at: Date, actorUserId: string): Promise<void>;
  deleteKey(orgId: string, provider: AiProvider, actorUserId: string): Promise<boolean>;
}

const keyEntity = (provider: AiProvider) => ({ entityType: 'ai_provider_key', entityId: provider });

/** The store on Postgres, as expensewise_app. It checks the role once, before first use. */
export function dbWorkspaceStore(db: Database): WorkspaceStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));

  return {
    async ensureOrganization(owner) {
      await safe();
      const { membership, created } = await ensureOwnerOrganization(db, owner);
      const [organization] = await withOrg(db, membership.orgId, (tx) =>
        tx
          .select({
            id: organizations.id,
            name: organizations.name,
            homeCurrency: organizations.homeCurrency,
          })
          .from(organizations),
      );
      if (!organization) throw new Error('The organization is not visible to its member');
      return { membership, organization, created };
    },
    async findMembership(userId) {
      await safe();
      return (await findMemberships(db, userId))[0];
    },
    async listKeys(orgId) {
      await safe();
      return withOrg(db, orgId, (tx) => listProviderKeys(tx));
    },
    async getKey(orgId, provider) {
      await safe();
      return withOrg(db, orgId, (tx) => getProviderKey(tx, provider));
    },
    async saveKey(orgId, key, actorUserId) {
      await safe();
      return withOrg(db, orgId, async (tx) => {
        const saved = await saveProviderKey(tx, orgId, key);
        await appendAuditEvent(tx, orgId, {
          actor: { type: 'user', id: actorUserId },
          ...keyEntity(key.provider),
          action: 'ai_provider_key.saved',
          // Never the key itself.
          payload: { keyHint: key.keyHint, authScheme: key.authScheme, memberId: key.memberId },
        });
        return saved;
      });
    },
    async markVerified(orgId, provider, at, actorUserId) {
      await safe();
      await withOrg(db, orgId, async (tx) => {
        await markProviderKeyVerified(tx, provider, at);
        await appendAuditEvent(tx, orgId, {
          actor: { type: 'user', id: actorUserId },
          ...keyEntity(provider),
          action: 'ai_provider_key.verified',
        });
      });
    },
    async deleteKey(orgId, provider, actorUserId) {
      await safe();
      return withOrg(db, orgId, async (tx) => {
        const removed = await deleteProviderKey(tx, provider);
        if (removed) {
          await appendAuditEvent(tx, orgId, {
            actor: { type: 'user', id: actorUserId },
            ...keyEntity(provider),
            action: 'ai_provider_key.removed',
          });
        }
        return removed;
      });
    },
  };
}
