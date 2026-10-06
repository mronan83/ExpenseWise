import { InngestTestEngine } from '@inngest/test';
import { describe, expect, it } from 'vitest';
import { createWorkflowClient } from './client.ts';
import { OUTBOX_NUDGE, outboxRelayFunction, RELAY_SCHEDULE } from './functions.ts';
import type { RelayPorts } from './relay.ts';

const client = createWorkflowClient({ isDev: true });

function emptyOutbox() {
  const calls: string[] = [];
  const ports: RelayPorts = {
    claim: (limit) => {
      calls.push(`claim:${limit}`);
      return Promise.resolve([]);
    },
    send: () => Promise.reject(new Error('nothing to send')),
    markPublished: () => Promise.reject(new Error('nothing to mark')),
  };
  return { ports, calls };
}

describe('outbox relay function', () => {
  it('runs on the sweep schedule and on a nudge, one run at a time', () => {
    const fn = outboxRelayFunction(client, () => emptyOutbox().ports);
    expect(fn.opts.triggers).toEqual([{ cron: RELAY_SCHEDULE }, { event: OUTBOX_NUDGE }]);
    expect(fn.opts.singleton).toEqual({ mode: 'skip' });
  });

  it('relays the outbox when a nudge arrives', async () => {
    const outbox = emptyOutbox();
    const t = new InngestTestEngine({
      function: outboxRelayFunction(client, () => outbox.ports),
      events: [{ name: OUTBOX_NUDGE, data: {} }],
    });
    const { result, error } = await t.execute();
    expect(error).toBeUndefined();
    expect(result).toEqual({ batches: 0, published: 0, drained: true });
    expect(outbox.calls).toEqual(['claim:100']);
  });
});
