import type { ClaimedOutboxEvent, CommittedEvent } from '@expensewise/db';

/** An outbox event on its way to the workflow runner. */
export interface WorkflowEvent {
  /**
   * The outbox event's id. The runner drops a second event with the same id for 24 hours,
   * so a batch that is sent again after a crash never starts a workflow twice.
   */
  readonly id: string;
  readonly name: string;
  readonly data: {
    readonly [key: string]: unknown;
    readonly orgId: string;
    readonly outboxId: string;
  };
  /** When the change happened, in epoch milliseconds, not when it was relayed. */
  readonly ts: number;
}

/** What the relay needs from the database and the workflow runner. */
export interface RelayPorts {
  /** Leases up to `limit` unpublished events for 5 minutes (claimOutboxBatch). */
  claim(limit: number): Promise<readonly ClaimedOutboxEvent[]>;
  send(events: readonly WorkflowEvent[]): Promise<void>;
  /** Returns how many of `ids` were still unpublished (markOutboxPublished). */
  markPublished(ids: readonly string[]): Promise<number>;
}

export interface RelayOptions {
  readonly batchSize?: number;
  /** Stops after this many batches, so one run stays short; the next run carries on. */
  readonly maxBatches?: number;
}

export interface RelayResult {
  readonly batches: number;
  readonly published: number;
  /** False when the run stopped at maxBatches with events possibly left. */
  readonly drained: boolean;
}

export function toWorkflowEvent(event: ClaimedOutboxEvent): WorkflowEvent {
  return {
    id: event.id,
    name: event.topic,
    // Our identifiers win over anything of the same name in the payload.
    data: { ...event.payload, orgId: event.orgId, outboxId: event.id },
    ts: Date.parse(event.createdAt),
  };
}

/**
 * An event just committed to the outbox, sent straight away rather than by the relay. Its id
 * is the outbox id, so the relay's later copy is dropped as a duplicate (ADR-0017).
 */
export function committedWorkflowEvent(event: CommittedEvent): WorkflowEvent {
  return toWorkflowEvent({
    id: event.outboxId,
    orgId: event.orgId,
    topic: event.topic,
    payload: { ...event.payload },
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
}

/**
 * Moves committed outbox events to the workflow runner: claim a batch, send it, then mark
 * it published. Delivery is at least once. If sending fails, nothing is marked and the
 * lease expires, so the batch is claimed and sent again; the runner's de-duplication by
 * event id turns that repeat into exactly-once workflow starts.
 */
export async function relayOutbox(
  ports: RelayPorts,
  { batchSize = 100, maxBatches = 10 }: RelayOptions = {},
): Promise<RelayResult> {
  let batches = 0;
  let published = 0;
  while (batches < maxBatches) {
    const claimed = await ports.claim(batchSize);
    if (claimed.length === 0) return { batches, published, drained: true };
    batches++;
    await ports.send(claimed.map(toWorkflowEvent));
    published += await ports.markPublished(claimed.map((e) => e.id));
    if (claimed.length < batchSize) return { batches, published, drained: true };
  }
  return { batches, published, drained: false };
}
