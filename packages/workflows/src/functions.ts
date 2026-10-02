import { claimOutboxBatch, markOutboxPublished, type Database } from '@expensewise/db';
import { Inngest } from 'inngest';
import { relayOutbox, type RelayPorts } from './relay.ts';

/** Sent after a commit that enqueued outbox events, so they don't wait for the sweep. */
export const OUTBOX_NUDGE = 'outbox/nudge';

/**
 * The safety-net sweep. Every 5 minutes is about 8,600 runs a month, a sixth of the free
 * plan's 50,000 executions, leaving the rest for real workflows (ADR-0014: no spend).
 */
export const RELAY_SCHEDULE = '*/5 * * * *';

export interface WorkflowClientConfig {
  /** Sends events to Inngest. Production needs it; the Vercel integration sets it. */
  readonly eventKey?: string;
  /** Verifies that calls to /api/inngest come from Inngest. */
  readonly signingKey?: string;
  /** Talks to a local Inngest dev server instead of Inngest Cloud. */
  readonly isDev?: boolean;
  /** Deployed commit SHA. */
  readonly appVersion?: string;
}

export function createWorkflowClient(config: WorkflowClientConfig = {}): Inngest {
  return new Inngest({ id: 'expensewise', ...config });
}

/** Wires the relay to the outbox (as expensewise_relay) and to Inngest. */
export function relayPorts(relay: Database, client: Inngest): RelayPorts {
  return {
    claim: (limit) => claimOutboxBatch(relay, limit),
    send: async (events) => {
      await client.send(events.map((e) => ({ id: e.id, name: e.name, data: e.data, ts: e.ts })));
    },
    markPublished: (ids) => markOutboxPublished(relay, ids),
  };
}

/**
 * Relays committed outbox events to Inngest on a schedule and on demand. A run that starts
 * while another is going is skipped. The run has no steps on purpose: each step costs an
 * execution, and the relay is safe to repeat as a whole (see relayOutbox).
 */
export function outboxRelayFunction(client: Inngest, ports: () => RelayPorts) {
  return client.createFunction(
    {
      id: 'outbox-relay',
      name: 'Outbox relay',
      triggers: [{ cron: RELAY_SCHEDULE }, { event: OUTBOX_NUDGE }],
      singleton: { mode: 'skip' },
      retries: 3,
    },
    () => relayOutbox(ports()),
  );
}
