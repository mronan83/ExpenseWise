import { newId } from '@expensewise/domain';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.ts';
import { outboxEvents } from './schema.ts';

/**
 * Records an event in the same transaction as the change it announces (the outbox pattern),
 * so a receipt row can never exist without the event that processes it.
 */
export async function enqueueOutbox(
  tx: Transaction,
  orgId: string,
  topic: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const id = newId();
  await tx.insert(outboxEvents).values({ id, orgId, topic, payload });
  return id;
}

/** An outbox event as the relay sees it. */
export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly orgId: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  /** Claims so far, this one included. */
  readonly attempts: number;
}

/**
 * Claims up to `limit` unpublished events across all organizations, oldest first. A claim
 * lasts 5 minutes; an event that is not marked published by then is claimed again. Only the
 * relay role (expensewise_relay) may call this, and it can read nothing else.
 */
export async function claimOutboxBatch(
  relay: Database,
  limit: number,
): Promise<ClaimedOutboxEvent[]> {
  const { rows } = await relay.execute<{
    id: string;
    org_id: string;
    topic: string;
    payload: Record<string, unknown>;
    created_at: Date | string;
    attempts: number;
  }>(
    sql`select id, org_id, topic, payload, created_at, attempts from claim_outbox_batch(${limit})`,
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    topic: r.topic,
    payload: r.payload,
    createdAt: new Date(r.created_at).toISOString(),
    attempts: r.attempts,
  }));
}

/** Marks events published. Returns how many were still unpublished. */
export async function markOutboxPublished(
  relay: Database,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await relay.execute<{ count: number }>(
    sql`select mark_outbox_published(${`{${ids.join(',')}}`}::uuid[]) as count`,
  );
  return rows[0]?.count ?? 0;
}
