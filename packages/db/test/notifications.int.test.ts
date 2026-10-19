import { checkPushSubscription, newId, NOTABLE_ACTIONS } from '@expensewise/domain';
import { readFileSync } from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { appendAuditEvent } from '../src/audit.ts';
import { withMember, withOrg } from '../src/client.ts';
import { setOrgFeature } from '../src/features.ts';
import {
  addPushSubscription,
  notificationSettings,
  pendingPushes,
  preparePush,
  PUSH_REQUESTED,
  pushWorkDue,
  removePushSubscription,
  requestTestNotification,
  setNotificationKind,
  settlePushes,
} from '../src/notifications.ts';
import { fileReceipt, settleReceipt } from '../src/receipts.ts';
import {
  auditEvents,
  members,
  notificationPreferences,
  notifications,
  outboxEvents,
  pushCursors,
  pushSubscriptions,
  reports,
} from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const NOW = new Date('2026-10-19T15:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const device = (n: number, timeZone: string | null = 'America/Chicago') => {
  const checked = checkPushSubscription({
    endpoint: `https://web.push.apple.com/device-${n}`,
    keys: { p256dh: `B${String(n).padStart(86, 'A')}`, auth: String(n).padStart(22, 'A') },
    timeZone,
  });
  if (!checked.ok) throw new Error('not a subscription');
  return checked.value;
};

/** An organization with notifications switched on, its owner, and a member, Alex. */
async function world(name: string) {
  const org = await seedOrg(app.db, name);
  const alex = { id: newId(), userId: `user_${newId()}` };
  await withOrg(app.db, org.orgId, async (tx) => {
    await tx.insert(members).values({
      id: alex.id,
      orgId: org.orgId,
      userId: alex.userId,
      email: `${name}-alex@example.com`,
      displayName: 'Alex Kim',
      role: 'member',
    });
    for (const flag of ['notifications.push', 'reports.approval']) {
      await setOrgFeature(
        tx,
        org.orgId,
        { flag, enabled: true, memberId: org.memberId },
        org.userId,
      );
    }
  });
  const asOwner = { orgId: org.orgId, memberId: org.memberId, role: 'owner' as const };
  const asAlex = { orgId: org.orgId, memberId: alex.id, role: 'member' as const };
  const allow = (who: typeof asAlex | typeof asOwner, userId: string, n: number, zone?: string) =>
    withMember(app.db, who, (tx) =>
      addPushSubscription(tx, org.orgId, who.memberId, device(n, zone), userId),
    );
  return { org, alex, asOwner, asAlex, allow };
}

let receipts = 0;

/** Files an emailed receipt for a member and reads it as `status`, each for its own amount. */
async function emailedReceipt(
  orgId: string,
  memberId: string,
  userId: string,
  status: 'extracted' | 'needs_review',
) {
  const id = newId();
  const filed = await withOrg(app.db, orgId, (tx) =>
    fileReceipt(
      tx,
      orgId,
      {
        id,
        memberId,
        source: 'email',
        storageKey: `orgs/x/receipts/${id}`,
        contentType: 'image/jpeg',
        byteSize: 1234,
        sha256: id.replaceAll('-', '').padEnd(64, '0'),
      },
      userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error('not filed');
  await withOrg(app.db, orgId, (tx) =>
    settleReceipt(tx, orgId, id, {
      status,
      requestId: filed.event.outboxId,
      detail: {},
      values: {
        merchant: 'Delta',
        transactionDate: '2026-10-18',
        currency: 'USD',
        amountMinor: 41_250 + 100 * ++receipts,
      },
    }),
  );
  return id;
}

/** A report of a member's, as the schedule closed it. */
async function closedBySchedule(orgId: string, memberId: string, title: string) {
  const id = newId();
  await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(reports).values({
      id,
      orgId,
      memberId,
      title,
      status: 'closed',
      currency: 'USD',
      closesAt: NOW,
      closedAt: NOW,
    });
    await appendAuditEvent(tx, orgId, {
      actor: { type: 'system', id: 'report-schedule' },
      entityType: 'report',
      entityId: id,
      action: 'report.closed',
      payload: { by: 'day 28', moved: [] },
    });
  });
  return id;
}

describe('allowing notifications on a device (FR-PLT-12, ADR-0053)', () => {
  it('keeps a member’s device and kinds as theirs alone, the trail naming only the service', async () => {
    const w = await world('push-allow');
    expect(await w.allow(w.asAlex, w.alex.userId, 1)).toBe('added');
    expect(await w.allow(w.asAlex, w.alex.userId, 1)).toBe('renewed');
    const settings = await withMember(app.db, w.asAlex, (tx) =>
      notificationSettings(tx, w.alex.id),
    );
    expect(settings.devices).toBe(1);
    expect(settings.kinds.every((k) => k.on)).toBe(true);
    expect(
      await withMember(app.db, w.asAlex, (tx) =>
        setNotificationKind(tx, w.org.orgId, w.alex.id, 'receipts', false, w.alex.userId),
      ),
    ).toBe('switched');
    expect(
      await withMember(app.db, w.asAlex, (tx) =>
        setNotificationKind(tx, w.org.orgId, w.alex.id, 'receipts', false, w.alex.userId),
      ),
    ).toBe('unchanged');
    // Not even the owner sees Alex's device, kinds or notifications.
    const seen = await withMember(app.db, w.asOwner, async (tx) => ({
      devices: await tx.select().from(pushSubscriptions),
      kinds: await tx.select().from(notificationPreferences),
      notes: await tx.select().from(notifications),
    }));
    expect(seen).toEqual({ devices: [], kinds: [], notes: [] });
    await expectDbError(
      withMember(app.db, w.asOwner, (tx) =>
        tx.insert(pushSubscriptions).values({
          orgId: w.org.orgId,
          memberId: w.alex.id,
          endpoint: 'https://web.push.apple.com/planted',
          p256dh: `B${'A'.repeat(86)}`,
          auth: 'A'.repeat(22),
        }),
      ),
      /own_records: as owner, this member may not change that push_subscriptions row/,
    );
    const trail = await withOrg(app.db, w.org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, w.alex.id)),
    );
    expect(trail.map((e) => [e.action, e.payload])).toEqual([
      ['push_subscription.added', { service: 'web.push.apple.com', replaced: 0 }],
      ['notification.kind_switched', { kind: 'receipts', on: false }],
    ]);
    expect(JSON.stringify(trail)).not.toContain('device-1');
    expect(
      await withMember(app.db, w.asAlex, (tx) =>
        removePushSubscription(
          tx,
          w.org.orgId,
          w.alex.id,
          'https://web.push.apple.com/device-1',
          w.alex.userId,
        ),
      ),
    ).toBe(true);
  });

  it('keeps ten devices a person at most, the newest, and starts the trail where it ends', async () => {
    const w = await world('push-devices');
    const before = await withOrg(app.db, w.org.orgId, (tx) =>
      tx.select({ sequence: auditEvents.sequence }).from(auditEvents),
    );
    for (let n = 1; n <= 11; n++) await w.allow(w.asAlex, w.alex.userId, n);
    const kept = await withMember(app.db, w.asAlex, (tx) =>
      tx.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions),
    );
    expect(kept).toHaveLength(10);
    expect(kept.map((k) => k.endpoint)).not.toContain('https://web.push.apple.com/device-1');
    const [cursor] = await withOrg(app.db, w.org.orgId, (tx) => tx.select().from(pushCursors));
    expect(cursor!.sequence).toBe(Math.max(...before.map((b) => b.sequence)));
    // Only the sweep moves it on.
    await expectDbError(
      withMember(app.db, w.asAlex, async (tx) => {
        const moved = await tx.update(pushCursors).set({ sequence: 0 }).returning();
        if (moved.length === 0) throw new Error('row-level security kept it');
      }),
      /row-level security/,
    );
  });

  it('holds a subscription and a notification to their shape in the database', async () => {
    const w = await world('push-shape');
    const row = {
      orgId: w.org.orgId,
      memberId: w.alex.id,
      p256dh: `B${'A'.repeat(86)}`,
      auth: 'A'.repeat(22),
    };
    await expectDbError(
      withOrg(app.db, w.org.orgId, (tx) =>
        tx.insert(pushSubscriptions).values({ ...row, endpoint: 'http://web.push.apple.com/x' }),
      ),
      /push_subscriptions_endpoint_https/,
    );
    await expectDbError(
      withOrg(app.db, w.org.orgId, (tx) =>
        tx
          .insert(pushSubscriptions)
          .values({ ...row, endpoint: 'https://web.push.apple.com/x', auth: 'short' }),
      ),
      /push_subscriptions_keys_length/,
    );
    const note = {
      orgId: w.org.orgId,
      memberId: w.alex.id,
      kind: 'test' as const,
      dedupeKey: 'k',
      title: 'Hello',
      body: 'There',
    };
    await expectDbError(
      withOrg(app.db, w.org.orgId, (tx) =>
        tx.insert(notifications).values({ ...note, url: 'https://elsewhere.example' }),
      ),
      /notifications_url_path/,
    );
    await expectDbError(
      withOrg(app.db, w.org.orgId, (tx) =>
        tx.insert(notifications).values({ ...note, url: '//elsewhere.example' }),
      ),
      /notifications_url_path/,
    );
  });
});

describe('the sweep (FR-PLT-12, R-PUSH-EVERY)', () => {
  it('tells a person of a receipt emailed in and filed, once, and sends it as one push', async () => {
    const w = await world('push-sweep');
    await w.allow(w.asAlex, w.alex.userId, 1);
    expect(await pushWorkDue(app.db, NOW, false)).not.toContain(w.org.orgId);
    const receiptId = await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'extracted');
    expect(await pushWorkDue(app.db, NOW, false)).toContain(w.org.orgId);

    expect(await preparePush(app.db, w.org.orgId, NOW)).toEqual({ read: 1, made: 1 });
    expect(await preparePush(app.db, w.org.orgId, later(5))).toEqual({ read: 0, made: 0 });
    const [push] = await pendingPushes(app.db, w.org.orgId, NOW);
    expect(push).toMatchObject({
      memberId: w.alex.id,
      message: {
        title: 'Receipt from Delta filed',
        body: 'The receipt you emailed is read and filed.',
        url: `/receipts/${receiptId}`,
      },
      devices: [{ endpoint: 'https://web.push.apple.com/device-1' }],
    });
    // Never an amount (Q58): $412.50 and the like are not on the lock screen.
    expect(`${push!.message.title} ${push!.message.body}`).not.toMatch(/\d/);

    await settlePushes(
      app.db,
      w.org.orgId,
      [{ notificationIds: push!.notificationIds, sent: [push!.devices[0]!.id], gone: [] }],
      NOW,
    );
    expect(await pendingPushes(app.db, w.org.orgId, later(1))).toEqual([]);
    expect(await pushWorkDue(app.db, later(1), false)).not.toContain(w.org.orgId);
  });

  it('moves the cursor past changes that tell no one, so they are not read again', async () => {
    const w = await world('push-cursor');
    await w.allow(w.asAlex, w.alex.userId, 1);
    // A kind switched is on the trail but tells no one.
    await withMember(app.db, w.asAlex, (tx) =>
      setNotificationKind(tx, w.org.orgId, w.alex.id, 'card', false, w.alex.userId),
    );
    await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'extracted');
    await preparePush(app.db, w.org.orgId, NOW);
    const [cursor] = await withOrg(app.db, w.org.orgId, (tx) => tx.select().from(pushCursors));
    const [end] = await withOrg(app.db, w.org.orgId, (tx) =>
      tx
        .select({ sequence: auditEvents.sequence })
        .from(auditEvents)
        .orderBy(desc(auditEvents.sequence))
        .limit(1),
    );
    expect(cursor!.sequence).toBe(end!.sequence);
  });

  it('makes nothing for a kind switched off, a person with no device, or the feature off', async () => {
    const w = await world('push-filter');
    await w.allow(w.asAlex, w.alex.userId, 1);
    await withMember(app.db, w.asAlex, (tx) =>
      setNotificationKind(tx, w.org.orgId, w.alex.id, 'receipts', false, w.alex.userId),
    );
    await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'extracted');
    // The owner has no device, so their receipt makes nothing either.
    await emailedReceipt(w.org.orgId, w.org.memberId, w.org.userId, 'extracted');
    expect(await preparePush(app.db, w.org.orgId, NOW)).toEqual({ read: 2, made: 0 });

    // Switched off, the trail is still read past, so nothing old is sent once it is back on.
    await withOrg(app.db, w.org.orgId, (tx) =>
      setOrgFeature(
        tx,
        w.org.orgId,
        { flag: 'notifications.push', enabled: false, memberId: w.org.memberId },
        w.org.userId,
      ),
    );
    await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'needs_review');
    expect(await preparePush(app.db, w.org.orgId, later(5))).toEqual({ read: 1, made: 0 });
    expect(await pushWorkDue(app.db, later(6), false)).not.toContain(w.org.orgId);
  });

  it('tells of a report the schedule closed, then reminds once a day from 9:00 the person’s time', async () => {
    const w = await world('push-reports');
    await w.allow(w.asAlex, w.alex.userId, 1, 'America/Chicago');
    const reportId = await closedBySchedule(w.org.orgId, w.alex.id, 'October report');
    // The day it closed, its own notification says to submit it; no reminder as well.
    expect(await preparePush(app.db, w.org.orgId, NOW)).toEqual({ read: 1, made: 1 });
    const [push] = await pendingPushes(app.db, w.org.orgId, NOW);
    expect(push!.message).toMatchObject({
      title: 'October report closed',
      body: 'It closed on its day. Submit it for approval.',
      url: `/reports/${reportId}`,
    });
    await settlePushes(
      app.db,
      w.org.orgId,
      [{ notificationIds: push!.notificationIds, sent: [push!.devices[0]!.id], gone: [] }],
      NOW,
    );
    expect(await preparePush(app.db, w.org.orgId, later(60))).toEqual({ read: 0, made: 0 });
    // 13:55 UTC is 8:55 in Chicago: not yet. 14:05 is 9:05: one reminder, and only one.
    expect(await preparePush(app.db, w.org.orgId, new Date('2026-10-20T13:55:00Z'))).toEqual({
      read: 0,
      made: 0,
    });
    const morning = new Date('2026-10-20T14:05:00Z');
    expect(await pushWorkDue(app.db, morning, true)).toContain(w.org.orgId);
    expect(await pushWorkDue(app.db, morning, false)).not.toContain(w.org.orgId);
    expect(await preparePush(app.db, w.org.orgId, morning)).toEqual({ read: 0, made: 1 });
    const [reminder] = await pendingPushes(app.db, w.org.orgId, morning);
    expect(reminder!.message).toMatchObject({
      title: 'October report is ready to submit',
      url: `/reports/${reportId}`,
    });
    await settlePushes(
      app.db,
      w.org.orgId,
      [{ notificationIds: reminder!.notificationIds, sent: [reminder!.devices[0]!.id], gone: [] }],
      morning,
    );
    expect(await pushWorkDue(app.db, later(24 * 60 + 70), true)).not.toContain(w.org.orgId);
    expect(await preparePush(app.db, w.org.orgId, later(24 * 60 + 70))).toEqual({
      read: 0,
      made: 0,
    });
    const keys = await withOrg(app.db, w.org.orgId, (tx) =>
      tx.select({ key: notifications.dedupeKey }).from(notifications),
    );
    expect(keys.map((k) => k.key).sort()).toEqual([
      expect.stringMatching(/^report\.closed:\d+$/),
      `submit:${reportId}:2026-10-20`,
    ]);
  });

  it('tries a push that failed again, gives it up after three, and drops a device that has gone', async () => {
    const w = await world('push-retry');
    await w.allow(w.asAlex, w.alex.userId, 1);
    await w.allow(w.asAlex, w.alex.userId, 2);
    await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'needs_review');
    await preparePush(app.db, w.org.orgId, NOW);
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      const [push] = await pendingPushes(app.db, w.org.orgId, later(tryNo));
      expect(push!.message.title).toBe('Receipt from Delta needs a look');
      const gone = tryNo === 1 ? [push!.devices.find((d) => d.endpoint.endsWith('-2'))!.id] : [];
      await settlePushes(
        app.db,
        w.org.orgId,
        [{ notificationIds: push!.notificationIds, sent: [], gone }],
        later(tryNo),
      );
    }
    expect(await pendingPushes(app.db, w.org.orgId, later(10))).toEqual([]);
    const left = await withMember(app.db, w.asAlex, (tx) =>
      tx.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions),
    );
    expect(left).toEqual([{ endpoint: 'https://web.push.apple.com/device-1' }]);
    const removed = await withOrg(app.db, w.org.orgId, (tx) =>
      tx
        .select({ actor: auditEvents.actorId, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.action, 'push_subscription.removed')),
    );
    expect(removed).toEqual([
      { actor: 'push-sweep', payload: { service: 'web.push.apple.com', by: 'push service' } },
    ]);
  });

  it('keeps a notification 90 days, then lets it go, sent or not', async () => {
    const w = await world('push-keep');
    await w.allow(w.asAlex, w.alex.userId, 1);
    await emailedReceipt(w.org.orgId, w.alex.id, w.alex.userId, 'extracted');
    await preparePush(app.db, w.org.orgId, NOW);
    const kept = () =>
      withOrg(app.db, w.org.orgId, (tx) => tx.select({ id: notifications.id }).from(notifications));
    expect(await kept()).toHaveLength(1);
    await preparePush(app.db, w.org.orgId, new Date(NOW.getTime() + 89 * 86_400_000));
    expect(await kept()).toHaveLength(1);
    await preparePush(app.db, w.org.orgId, new Date(NOW.getTime() + 91 * 86_400_000));
    expect(await kept()).toEqual([]);
  });

  it('sends a test the person asks for, through the outbox', async () => {
    const w = await world('push-test');
    expect(
      await withMember(app.db, w.asAlex, (tx) =>
        requestTestNotification(tx, w.org.orgId, w.alex.id, w.alex.userId),
      ),
    ).toEqual({ status: 'no_devices' });
    await w.allow(w.asAlex, w.alex.userId, 1);
    const asked = await withMember(app.db, w.asAlex, (tx) =>
      requestTestNotification(tx, w.org.orgId, w.alex.id, w.alex.userId),
    );
    expect(asked).toMatchObject({ status: 'requested', event: { topic: PUSH_REQUESTED } });
    const [outbox] = await withOrg(app.db, w.org.orgId, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.topic, PUSH_REQUESTED)),
    );
    expect(outbox).toBeDefined();
    expect(await pushWorkDue(app.db, NOW, false)).toContain(w.org.orgId);
    const [push] = await pendingPushes(app.db, w.org.orgId, new Date());
    expect(push!.message).toMatchObject({
      title: 'Notifications are on',
      url: '/settings/notifications',
    });
  });

  it('reads the trail for every action the domain notifies of', () => {
    const sql = readFileSync(
      new URL('../migrations/0066_push_notifications_rls.sql', import.meta.url),
      'utf8',
    );
    for (const action of NOTABLE_ACTIONS) expect(sql).toContain(`'${action}'`);
  });
});
