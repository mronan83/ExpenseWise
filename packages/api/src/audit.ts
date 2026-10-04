import {
  assertRowSecurityApplies,
  auditActorNames,
  checkAuditChain,
  listAuditEvents,
  withOrg,
  type AuditActorName,
  type AuditChainCheck,
  type AuditFilter,
  type Database,
} from '@expensewise/db';
import type { ChainedAuditEvent } from '@expensewise/domain';

/** Events on a page of the audit trail, unless the caller asks for another number. */
export const AUDIT_PAGE_SIZE = 50;
/** The most events one page holds. */
export const AUDIT_PAGE_MAX = 100;

/** Some of the trail, newest first, with the people who made those changes. */
export interface AuditPage {
  readonly events: readonly ChainedAuditEvent[];
  readonly actors: readonly AuditActorName[];
}

/** What the API needs from the database for the audit trail. Tests use an in-memory fake. */
export interface AuditStore {
  /** Up to `limit` events that match, newest first, read in one transaction with their people. */
  page(orgId: string, filter: AuditFilter, limit: number): Promise<AuditPage>;
  /** Recomputes the organization's whole chain (FR-GOV-05). */
  verify(orgId: string): Promise<AuditChainCheck>;
}

/** The audit store on Postgres, as expensewise_app. It checks the role once. */
export function dbAuditStore(db: Database): AuditStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));

  return {
    page: async (orgId, filter, limit) => {
      await safe();
      return withOrg(db, orgId, async (tx) => {
        const events = await listAuditEvents(tx, orgId, filter, limit);
        const people = events.filter((e) => e.actor.type === 'user' && e.actor.id !== null);
        const actors = await auditActorNames(
          tx,
          people.map((e) => e.actor.id!),
        );
        return { events, actors };
      });
    },
    verify: async (orgId) => {
      await safe();
      return withOrg(db, orgId, (tx) => checkAuditChain(tx, orgId));
    },
  };
}
