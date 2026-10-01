import { newId } from '@expensewise/domain';
import type { Transaction } from './client.ts';
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
