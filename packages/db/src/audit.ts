import {
  GENESIS_HASH,
  chainAuditEvent,
  newId,
  type AuditEventInput,
  type ChainedAuditEvent,
} from '@expensewise/domain';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from './client.ts';
import { auditEvents } from './schema.ts';

export interface AuditEntry {
  readonly actor: AuditEventInput['actor'];
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly payload?: Readonly<Record<string, unknown>>;
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
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`audit:${orgId}`}, 0))`);
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

/** Reads an organization's chain back in order, ready for verifyAuditChain(). */
export async function readAuditChain(tx: Transaction, orgId: string): Promise<ChainedAuditEvent[]> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.orgId, orgId))
    .orderBy(asc(auditEvents.sequence));
  return rows.map((row) => ({
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
  }));
}
