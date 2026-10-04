import {
  GENESIS_HASH,
  chainAuditEvent,
  newId,
  verifyAuditChain,
  type AuditEventInput,
  type ChainedAuditEvent,
} from '@expensewise/domain';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { auditEvents, members, memberSignIns } from './schema.ts';

export interface AuditEntry {
  readonly actor: AuditEventInput['actor'];
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Takes the organization's write lock until the transaction ends. Every audit append takes it,
 * so every change already holds it from its first event to its commit. A change that must see
 * the others settled first, such as filing expenses to trips (ADR-0023), takes it before it
 * locks or reads any rows: that adds no new waiting and no new lock order.
 */
export async function lockOrgWrites(tx: Transaction, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`audit:${orgId}`}, 0))`);
}

/**
 * Appends the next event to the organization's hash chain, inside the caller's transaction,
 * so the audit event commits or rolls back together with the change it records.
 */
export async function appendAuditEvent(
  tx: Transaction,
  orgId: string,
  entry: AuditEntry,
): Promise<ChainedAuditEvent> {
  // Serialize appends per organization so two writers never claim the same sequence.
  await lockOrgWrites(tx, orgId);
  const [last] = await tx
    .select({ sequence: auditEvents.sequence, hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.orgId, orgId))
    .orderBy(desc(auditEvents.sequence))
    .limit(1);

  const event = await chainAuditEvent(last?.hash ?? GENESIS_HASH, {
    orgId,
    sequence: (last?.sequence ?? 0) + 1,
    actor: entry.actor,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    occurredAt: new Date().toISOString(),
    payload: entry.payload ?? {},
  });

  await tx.insert(auditEvents).values({
    id: newId(),
    orgId,
    sequence: event.sequence,
    actorType: event.actor.type,
    actorId: event.actor.id,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    payload: event.payload,
    occurredAt: new Date(event.occurredAt),
    prevHash: event.prevHash,
    hash: event.hash,
  });
  return event;
}

/** A stored row as the event it was hashed from: exactly those fields, so it re-hashes. */
const chained = (row: typeof auditEvents.$inferSelect): ChainedAuditEvent => ({
  orgId: row.orgId,
  sequence: row.sequence,
  actor: { type: row.actorType, id: row.actorId },
  entityType: row.entityType,
  entityId: row.entityId,
  action: row.action,
  occurredAt: row.occurredAt.toISOString(),
  payload: row.payload as Record<string, unknown>,
  prevHash: row.prevHash,
  hash: row.hash,
});

/** Reads an organization's chain back in order, ready for verifyAuditChain(). */
export async function readAuditChain(tx: Transaction, orgId: string): Promise<ChainedAuditEvent[]> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.orgId, orgId))
    .orderBy(asc(auditEvents.sequence));
  return rows.map(chained);
}

/** Which events of the trail to show. Every term given must match. */
export interface AuditFilter {
  readonly entityType?: string;
  readonly entityId?: string;
  /** Who made the change: a sign-in's user id, or a workflow's name. */
  readonly actorId?: string;
  /** Only events numbered below this: the page after one that ended there. */
  readonly before?: number;
}

/**
 * The organization's events, newest first, at most `limit` (FR-GOV-06). Pages by sequence,
 * which is gapless and never reused, so an event appended meanwhile never shifts a page.
 * Call inside withOrg().
 */
export async function listAuditEvents(
  tx: Transaction,
  orgId: string,
  filter: AuditFilter,
  limit: number,
): Promise<ChainedAuditEvent[]> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.orgId, orgId),
        filter.entityType === undefined ? undefined : eq(auditEvents.entityType, filter.entityType),
        filter.entityId === undefined ? undefined : eq(auditEvents.entityId, filter.entityId),
        filter.actorId === undefined ? undefined : eq(auditEvents.actorId, filter.actorId),
        filter.before === undefined ? undefined : lt(auditEvents.sequence, filter.before),
      ),
    )
    .orderBy(desc(auditEvents.sequence))
    .limit(limit);
  return rows.map(chained);
}

/** A person who made changes, by the sign-in they made them with. */
export interface AuditActorName {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/**
 * The members behind the given sign-ins, so the trail can say who, not only an id. A sign-in
 * since removed or moved to another organization is not found. Call inside withOrg().
 */
export async function auditActorNames(
  tx: Transaction,
  userIds: readonly string[],
): Promise<AuditActorName[]> {
  if (userIds.length === 0) return [];
  return tx
    .select({ userId: memberSignIns.userId, name: members.displayName, email: memberSignIns.email })
    .from(memberSignIns)
    .innerJoin(
      members,
      and(eq(members.orgId, memberSignIns.orgId), eq(members.id, memberSignIns.memberId)),
    )
    .where(inArray(memberSignIns.userId, [...new Set(userIds)]));
}

/** What recomputing an organization's chain found. */
export interface AuditChainCheck {
  readonly intact: boolean;
  /** Events recomputed: every one, or those up to and including the first that breaks. */
  readonly checked: number;
  /** Events in the chain. */
  readonly total: number;
  /** The first event that doesn't verify, or null while the chain holds. */
  readonly brokenAt: ChainedAuditEvent | null;
}

/**
 * Recomputes the organization's whole chain from its stored events, with the same functions
 * that wrote it, and says where it first breaks (FR-GOV-05, FR-GOV-06). Call inside withOrg().
 */
export async function checkAuditChain(tx: Transaction, orgId: string): Promise<AuditChainCheck> {
  const chain = await readAuditChain(tx, orgId);
  const result = await verifyAuditChain(chain);
  if (result.ok)
    return { intact: true, checked: chain.length, total: chain.length, brokenAt: null };
  return {
    intact: false,
    checked: result.brokenAt + 1,
    total: chain.length,
    brokenAt: chain[result.brokenAt] ?? null,
  };
}
