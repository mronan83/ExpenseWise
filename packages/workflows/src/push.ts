import {
  PUSH_REQUESTED,
  pendingPushes,
  preparePush,
  pushWorkDue,
  settlePushes,
  type Database,
  type PendingPush,
  type PushOutcome,
  type PushPrepared,
} from '@expensewise/db';
import { PUSH_SWEEP, type PushMessage } from '@expensewise/domain';
import type { Inngest } from 'inngest';
import webpush from 'web-push';

/*
 * Push notifications (FR-PLT-12, ADR-0053): every five minutes, and at once when a test is
 * asked for, the sweep makes each organization's new notifications and sends each person's as
 * one push, to every device they allowed. About 8,600 runs a month, as many as the outbox
 * relay's, inside the free plan's 50,000 executions (ADR-0014).
 */

/** The server's VAPID identity: who sends, to Apple's push service and the others. */
export interface VapidIdentity {
  /** An https: URL or a mailto: address the push services can reach the sender at. */
  readonly subject: string;
  /** P-256 keys, base64url: the uncompressed public point and the private scalar. */
  readonly publicKey: string;
  readonly privateKey: string;
}

/** How one device's push went: taken, gone for good, or failed for now. */
export type PushDelivery = 'sent' | 'gone' | 'failed';

/** Sends one push to one device. Never logs the device's address or keys. */
export type PushSender = (
  device: PendingPush['devices'][number],
  message: PushMessage,
) => Promise<PushDelivery>;

/** How long a push service keeps a push for a phone that is off: a day. */
const PUSH_TTL_SECONDS = 86_400;

/**
 * Sends with the Web Push protocol (RFC 8030), encrypted for the device (RFC 8291) and signed
 * with the server's VAPID key (RFC 8292). Only 404 and 410 mean the subscription has ended; a
 * 403 can be our own signing, so it is tried again rather than dropping every device at once.
 */
export function webPushSender(
  vapid: VapidIdentity,
  send: typeof fetch = globalThis.fetch,
): PushSender {
  return async (device, message) => {
    const request = webpush.generateRequestDetails(
      { endpoint: device.endpoint, keys: { ...device.keys } },
      JSON.stringify(message),
      {
        vapidDetails: vapid,
        TTL: PUSH_TTL_SECONDS,
        urgency: 'normal',
        contentEncoding: 'aes128gcm',
      },
    );
    let status: number;
    try {
      const response = await send(request.endpoint, {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
        ),
        body: new Uint8Array(request.body),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    } catch {
      return 'failed';
    }
    if (status >= 200 && status < 300) return 'sent';
    if (status === 404 || status === 410) return 'gone';
    return 'failed';
  };
}

export interface PushSweepPorts {
  /** The organizations with notifications to make or send (push_work_due()). */
  dueOrganizations(now: Date, reminders: boolean): Promise<string[]>;
  prepare(orgId: string, now: Date): Promise<PushPrepared>;
  pending(orgId: string, now: Date): Promise<PendingPush[]>;
  send: PushSender;
  settle(orgId: string, outcomes: readonly PushOutcome[], now: Date): Promise<void>;
  now?(): Date;
}

export interface PushSweepSummary {
  readonly organizations: number;
  readonly made: number;
  readonly pushes: number;
  readonly sent: number;
  readonly gone: number;
  readonly failed: number;
}

/**
 * One sweep (R-PUSH-EVERY): for each organization with work, makes its notifications, then
 * sends each person's waiting ones as one push to each of their devices and records how it
 * went. The reports to remind of are looked for in the first sweep of each hour. One
 * organization failing doesn't hold up the rest; the run then fails and is retried, which
 * sends nothing twice that was recorded as sent. Logs one line, with counts only.
 */
export async function sweepPush(ports: PushSweepPorts): Promise<PushSweepSummary> {
  const now = ports.now?.() ?? new Date();
  const organizations = await ports.dueOrganizations(now, now.getUTCMinutes() < 5);
  const failures: unknown[] = [];
  let made = 0;
  let pushes = 0;
  const devices = { sent: 0, gone: 0, failed: 0 };
  for (const orgId of organizations) {
    try {
      made += (await ports.prepare(orgId, now)).made;
      const waiting = await ports.pending(orgId, now);
      const outcomes: PushOutcome[] = [];
      for (const push of waiting) {
        pushes++;
        const results = await Promise.all(
          push.devices.map(async (d) => [d.id, await ports.send(d, push.message)] as const),
        );
        for (const [, result] of results) devices[result]++;
        outcomes.push({
          notificationIds: push.notificationIds,
          sent: results.filter(([, r]) => r === 'sent').map(([id]) => id),
          gone: results.filter(([, r]) => r === 'gone').map(([id]) => id),
        });
      }
      if (outcomes.length > 0) await ports.settle(orgId, outcomes, now);
    } catch (error) {
      failures.push(error);
    }
  }
  const summary: PushSweepSummary = {
    organizations: organizations.length,
    made,
    pushes,
    ...devices,
  };
  console.log('push-sweep', { ...summary, failedOrganizations: failures.length });
  if (failures.length > 0) {
    throw new AggregateError(failures, `Push failed for ${failures.length} organization(s)`);
  }
  return summary;
}

/** Wires the sweep to Postgres as expensewise_app and to a sender. */
export function pushSweepPorts(db: Database, send: PushSender): PushSweepPorts {
  return {
    dueOrganizations: (now, reminders) => pushWorkDue(db, now, reminders),
    prepare: (orgId, now) => preparePush(db, orgId, now),
    pending: (orgId, now) => pendingPushes(db, orgId, now),
    send,
    settle: (orgId, outcomes, now) => settlePushes(db, orgId, outcomes, now),
  };
}

/**
 * The sweep, on its schedule and when a push is asked for now. One runs at a time; one asked
 * for while another runs waits for it rather than being dropped, so a test is never lost.
 */
export function pushSweepFunction(client: Inngest, ports: () => PushSweepPorts) {
  return client.createFunction(
    {
      id: 'push-sweep',
      name: 'Push notifications',
      triggers: [{ cron: PUSH_SWEEP }, { event: PUSH_REQUESTED }],
      concurrency: { limit: 1 },
      retries: 2,
    },
    () => sweepPush(ports()),
  );
}
