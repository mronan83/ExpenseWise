import {
  appendAuditEvent,
  assertRowSecurityApplies,
  deleteProviderKey,
  ensureOwnerOrganization,
  findSignedInMember,
  getProviderKey,
  linkSignIn,
  listOrgFeatures,
  listProviderKeys,
  listSignIns,
  markProviderKeyVerified,
  orgFeatureOn,
  organizations,
  saveProviderKey,
  setOrgFeature,
  signInAuthenticators,
  unlinkSignIn,
  withOrg,
  type AiProvider,
  type Database,
  type LinkResult,
  type Membership,
  type OrgFeature,
  type SignIn,
  type ProviderKeyWrite,
  type StoredProviderKey,
} from '@expensewise/db';

export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly homeCurrency: string;
}

/**
 * The member a sign-in reaches, and whether that sign-in has a verified second factor in
 * Supabase Auth, such as an authenticator app, read as the request resolves it (#85, ADR-0044).
 * A store that can't tell, as a test's in-memory one, leaves `authenticator` out: none.
 */
export interface CallerMembership extends Membership {
  readonly authenticator?: boolean;
  /**
   * Whether any email the person signs in with, this one or another linked to their
   * membership, has one (#88, Q43): when it does and this one hasn't, this email is held until
   * it adds its own. Left out: none.
   */
  readonly personAuthenticator?: boolean;
}

/**
 * What the API needs from the database for organizations and provider keys. Every write
 * appends its audit event in the same transaction. Tests use an in-memory fake.
 */
export interface WorkspaceStore {
  ensureOrganization(owner: {
    userId: string;
    email: string;
  }): Promise<{ membership: CallerMembership; organization: OrganizationView; created: boolean }>;
  findMembership(userId: string): Promise<CallerMembership | undefined>;
  listKeys(orgId: string): Promise<StoredProviderKey[]>;
  getKey(orgId: string, provider: AiProvider): Promise<StoredProviderKey | undefined>;
  saveKey(orgId: string, key: ProviderKeyWrite, actorUserId: string): Promise<StoredProviderKey>;
  markVerified(orgId: string, provider: AiProvider, at: Date, actorUserId: string): Promise<void>;
  deleteKey(orgId: string, provider: AiProvider, actorUserId: string): Promise<boolean>;
  listSignIns(member: Membership): Promise<SignIn[]>;
  linkSignIn(
    member: Membership,
    other: { userId: string; email: string },
    actorUserId: string,
  ): Promise<LinkResult>;
  unlinkSignIn(
    member: Membership,
    signInId: string,
    actorUserId: string,
  ): Promise<'removed' | 'not_found' | 'last'>;
  /** The features this organization has switched; the rest are off. */
  listFeatures(orgId: string): Promise<OrgFeature[]>;
  featureOn(orgId: string, flag: string): Promise<boolean>;
  switchFeature(
    member: Membership,
    change: { flag: string; enabled: boolean },
    actorUserId: string,
  ): Promise<'switched' | 'unchanged'>;
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
      const { organization, authenticators } = await withOrg(db, membership.orgId, async (tx) => ({
        organization: (
          await tx
            .select({
              id: organizations.id,
              name: organizations.name,
              homeCurrency: organizations.homeCurrency,
            })
            .from(organizations)
        )[0],
        authenticators: await signInAuthenticators(tx, owner.userId),
      }));
      if (!organization) throw new Error('The organization is not visible to its member');
      return { membership: { ...membership, ...authenticators }, organization, created };
    },
    async findMembership(userId) {
      await safe();
      // Whether their sign-in, and any other of theirs, has a second factor comes in the same
      // query (#85, #88).
      return findSignedInMember(db, userId);
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
    async listSignIns(member) {
      await safe();
      return withOrg(db, member.orgId, (tx) => listSignIns(tx, member.memberId));
    },
    async linkSignIn(member, other, actorUserId) {
      await safe();
      return linkSignIn(db, member, other, actorUserId);
    },
    async unlinkSignIn(member, signInId, actorUserId) {
      await safe();
      return unlinkSignIn(db, member, signInId, actorUserId);
    },
    async listFeatures(orgId) {
      await safe();
      return withOrg(db, orgId, (tx) => listOrgFeatures(tx, orgId));
    },
    async featureOn(orgId, flag) {
      await safe();
      return withOrg(db, orgId, (tx) => orgFeatureOn(tx, orgId, flag));
    },
    async switchFeature(member, change, actorUserId) {
      await safe();
      return withOrg(db, member.orgId, (tx) =>
        setOrgFeature(tx, member.orgId, { ...change, memberId: member.memberId }, actorUserId),
      );
    },
  };
}
