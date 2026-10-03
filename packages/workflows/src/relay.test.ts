import type { ClaimedOutboxEvent } from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import {
  committedWorkflowEvent,
  relayOutbox,
  toWorkflowEvent,
  type RelayPorts,
  type WorkflowEvent,
} from './relay.ts';

const ORG = '0192f7a0-0000-7000-8000-000000000001';

function outboxEvent(n: number): ClaimedOutboxEvent {
  return {
    id: `0192f7a0-0000-7000-8000-${String(n).padStart(12, '0')}`,
    orgId: ORG,
    topic: 'receipt.uploaded',
    payload: { receiptId: `r${n}` },
    createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, n)).toISOString(),
    attempts: 1,
  };
}

/** An in-memory outbox with the database's lease semantics, minus expiry. */
function fakePorts(count: number, options: { failSend?: boolean } = {}) {
  const pending = Array.from({ length: count }, (_, i) => outboxEvent(i + 1));
  const claimed = new Set<string>();
  const published = new Set<string>();
  const sent: WorkflowEvent[] = [];
  const calls: string[] = [];
  const ports: RelayPorts = {
    claim: (limit) => {
      calls.push(`claim:${limit}`);
      const batch = pending
        .filter((e) => !claimed.has(e.id) && !published.has(e.id))
        .slice(0, limit);
      for (const e of batch) claimed.add(e.id);
      return Promise.resolve(batch);
    },
    send: (events) => {
      calls.push(`send:${events.length}`);
      if (options.failSend) return Promise.reject(new Error('runner unavailable'));
      sent.push(...events);
      return Promise.resolve();
    },
    markPublished: (ids) => {
      calls.push(`mark:${ids.length}`);
      const fresh = ids.filter((id) => !published.has(id));
      for (const id of fresh) published.add(id);
      return Promise.resolve(fresh.length);
    },
  };
  return { ports, sent, published, calls };
}

describe('toWorkflowEvent', () => {
  it('uses the outbox id as the event id and the change time as the timestamp', () => {
    const e = outboxEvent(7);
    expect(toWorkflowEvent(e)).toEqual({
      id: e.id,
      name: 'receipt.uploaded',
      data: { receiptId: 'r7', orgId: ORG, outboxId: e.id },
      ts: Date.UTC(2026, 9, 2, 12, 0, 7),
    });
  });

  it('never lets the payload override the organization or outbox id', () => {
    const e = { ...outboxEvent(1), payload: { orgId: 'someone-else', outboxId: 'forged' } };
    expect(toWorkflowEvent(e).data).toEqual({ orgId: ORG, outboxId: e.id });
  });
});

describe('committedWorkflowEvent', () => {
  it('sends an event just committed under its outbox id, as the relay would', () => {
    const event = committedWorkflowEvent({
      outboxId: 'ob-1',
      orgId: ORG,
      topic: 'receipt.uploaded',
      payload: { receiptId: 'r1' },
    });
    expect(event).toMatchObject({
      id: 'ob-1',
      name: 'receipt.uploaded',
      data: { receiptId: 'r1', orgId: ORG, outboxId: 'ob-1' },
    });
  });
});

describe('relayOutbox', () => {
  it('does nothing when the outbox is empty', async () => {
    const { ports, calls } = fakePorts(0);
    expect(await relayOutbox(ports)).toEqual({ batches: 0, published: 0, drained: true });
    expect(calls).toEqual(['claim:100']);
  });

  it('sends each batch before marking it published', async () => {
    const { ports, sent, calls } = fakePorts(5);
    expect(await relayOutbox(ports, { batchSize: 2 })).toEqual({
      batches: 3,
      published: 5,
      drained: true,
    });
    expect(calls).toEqual([
      'claim:2',
      'send:2',
      'mark:2',
      'claim:2',
      'send:2',
      'mark:2',
      'claim:2',
      'send:1',
      'mark:1',
    ]);
    expect(sent.map((e) => e.data.receiptId)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('checks once more when the last batch was exactly full', async () => {
    const { ports, calls } = fakePorts(2);
    expect(await relayOutbox(ports, { batchSize: 2 })).toEqual({
      batches: 1,
      published: 2,
      drained: true,
    });
    expect(calls).toEqual(['claim:2', 'send:2', 'mark:2', 'claim:2']);
  });

  it('stops at maxBatches and says the outbox may not be empty', async () => {
    const { ports, published } = fakePorts(10);
    expect(await relayOutbox(ports, { batchSize: 2, maxBatches: 2 })).toEqual({
      batches: 2,
      published: 4,
      drained: false,
    });
    expect(published.size).toBe(4);
  });

  it('marks nothing published when sending fails, so the lease expires and it is retried', async () => {
    const { ports, published, calls } = fakePorts(3, { failSend: true });
    await expect(relayOutbox(ports)).rejects.toThrow('runner unavailable');
    expect(published.size).toBe(0);
    expect(calls).toEqual(['claim:100', 'send:3']);
  });
});
