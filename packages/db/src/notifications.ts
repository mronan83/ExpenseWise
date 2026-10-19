import {
  CHOSEN_KINDS,
  NOTABLE_ACTIONS,
  PUSH_DEVICES_MAX,
  PUSH_KEEP_DAYS,
  PUSH_SEND_TRIES,
  newId,
  notificationsFor,
  pushMessage,
  reminderDay,
  submitReminder,
  type NotableChange,
  type NotificationDraft,
  type NotificationKind,
  type PushMessage,
  type PushSubscriptionInput,
} from '@expensewise/domain';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { appendAuditEvent, type AuditEntry } from './audit.ts';
import { withOrg, type Database, type Transaction } from './client.ts';
import { featureOn } from './features.ts';
import { enqueueOutbox } from './outbox.ts';
import type { CommittedEvent } from './receipts.ts';
import {
  auditEvents,
  cardStatements,
  expenses,
  inboundEmails,
  members,
  mileageRoutes,
  notificationPreferences,
  notifications,
  pushCursors,
  pushSubscriptions,
  receiptDuplicates,
  receipts,
  reports,
  trips,
} from './schema.ts';

/*
 * Push notifications (FR-PLT-12, ADR-0053). A member allows them on a device, which keeps a
 * subscription, and switches each kind. Every five minutes the sweep reads the organization's
 * audit trail past its cursor for changes that tell someone something, makes a notification
 * for each person each tells, once, and sends what each person has waiting as one push.
 */

/** Sent after a commit that made a notification to send now, such as a test. */
export const PUSH_REQUESTED = 'notifications.push_requested';

const PUSH_FLAG = 'notifications.push' as const;

/** How the report schedule signs what it does, so a person's own moves are not notified. */
const REPORT_SCHEDULE_ID = 'report-schedule';

/** Most changes read from the trail in one sweep; the rest wait for the next. */
const CHANGES_PER_SWEEP = 200;

/** A notification waits this long to be sent before it is given up. */
const SEND_WITHIN_MS = 86_400_000;

/** A member's settings: whether each kind is on, and how many devices are allowed. */
export interface NotificationSettings {
  readonly kinds: readonly { readonly kind: NotificationKind; readonly on: boolean }[];
  readonly devices: number;
}

/** A member's notification settings. Call inside withOrg(), as the member. */
export async function notificationSettings(
  tx: Transaction,
  memberId: string,
): Promise<NotificationSettings> {
  const off = await switchedOff(tx, [memberId]);
  const [devices] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.memberId, memberId));
  return {
    kinds: CHOSEN_KINDS.map((kind) => ({ kind, on: !off.has(`${memberId}:${kind}`) })),
    devices: devices?.n ?? 0,
  };
}

/** The kinds members switched off, as `memberId:kind`. */
async function switchedOff(tx: Transaction, memberIds: readonly string[]) {
  if (memberIds.length === 0) return new Set<string>();
  const rows = await tx
    .select({ memberId: notificationPreferences.memberId, kind: notificationPreferences.kind })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.memberId, [...memberIds]),
        eq(notificationPreferences.enabled, false),
      ),
    );
  return new Set(rows.map((r) => `${r.memberId}:${r.kind}`));
}

/**
 * Switches one kind on or off for a member, with its audit event. Unchanged when it already
 * was. Call inside withOrg(), as the member.
 */
export async function setNotificationKind(
  tx: Transaction,
  orgId: string,
  memberId: string,
  kind: Exclude<NotificationKind, 'test'>,
  on: boolean,
  actorUserId: string,
): Promise<'switched' | 'unchanged'> {
  const [before] = await tx
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.memberId, memberId), eq(notificationPreferences.kind, kind)),
    )
    .for('update');
  if ((before?.enabled ?? true) === on) return 'unchanged';
  await tx
    .insert(notificationPreferences)
    .values({ orgId, memberId, kind, enabled: on })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.orgId,
        notificationPreferences.memberId,
        notificationPreferences.kind,
      ],
      set: { enabled: on, updatedAt: new Date() },
    });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'notification.kind_switched',
    payload: { kind, on },
  });
  return 'switched';
}

/** The push service a subscription is at, for the audit trail: never its address. */
const serviceOf = (endpoint: string) => new URL(endpoint).hostname;

/** Starts the organization's cursor at the end of its trail, unless it has one. */
async function startCursor(tx: Transaction, orgId: string) {
  await tx.execute(sql`
    insert into push_cursors (id, org_id, sequence)
    select ${newId()}, ${orgId}, coalesce(max(sequence), 0) from audit_events
     where org_id = ${orgId}
    on conflict (org_id) do nothing`);
}

/**
 * Keeps a device's subscription for a member, checked by checkPushSubscription(), or renews
 * it with new keys. Past PUSH_DEVICES_MAX, the oldest goes. Starts the organization's cursor
 * if this is its first. The trail names the push service, never the address. Call inside
 * withOrg(), as the member.
 */
export async function addPushSubscription(
  tx: Transaction,
  orgId: string,
  memberId: string,
  subscription: PushSubscriptionInput & { readonly timeZone: string | null },
  actorUserId: string,
): Promise<'added' | 'renewed'> {
  const [existing] = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.memberId, memberId),
        eq(pushSubscriptions.endpoint, subscription.endpoint),
      ),
    )
    .for('update');
  const keys = {
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    timeZone: subscription.timeZone,
  };
  if (existing) {
    await tx.update(pushSubscriptions).set(keys).where(eq(pushSubscriptions.id, existing.id));
    return 'renewed';
  }
  await tx
    .insert(pushSubscriptions)
    .values({ orgId, memberId, endpoint: subscription.endpoint, ...keys });
  const kept = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.memberId, memberId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id));
  const extra = kept.slice(PUSH_DEVICES_MAX).map((r) => r.id);
  if (extra.length > 0) {
    await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, extra));
  }
  await startCursor(tx, orgId);
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'push_subscription.added',
    payload: { service: serviceOf(subscription.endpoint), replaced: extra.length },
  });
  return 'added';
}

/** Stops a device's notifications for a member. False when it had none. Call as the member. */
export async function removePushSubscription(
  tx: Transaction,
  orgId: string,
  memberId: string,
  endpoint: string,
  actorUserId: string,
): Promise<boolean> {
  const removed = await tx
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.memberId, memberId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ endpoint: pushSubscriptions.endpoint });
  if (removed.length === 0) return false;
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'push_subscription.removed',
    payload: { service: serviceOf(endpoint), by: 'person' },
  });
  return true;
}

/**
 * Makes a test notification for the member and asks for it to be sent now, with its outbox
 * event. 'no_devices' when the member has allowed notifications on none. Call as the member.
 */
export async function requestTestNotification(
  tx: Transaction,
  orgId: string,
  memberId: string,
  actorUserId: string,
): Promise<{ status: 'requested'; event: CommittedEvent } | { status: 'no_devices' }> {
  const [device] = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.memberId, memberId))
    .limit(1);
  if (!device) return { status: 'no_devices' };
  const id = newId();
  await tx.insert(notifications).values({
    id,
    orgId,
    memberId,
    kind: 'test',
    dedupeKey: `test:${id}`,
    title: 'Notifications are on',
    body: 'This is how ExpenseWise tells you when something needs you.',
    url: '/settings/notifications',
  });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'notification.test_requested',
    payload: {},
  });
  const payload = { reason: 'test' };
  const outboxId = await enqueueOutbox(tx, orgId, PUSH_REQUESTED, payload);
  return { status: 'requested', event: { outboxId, topic: PUSH_REQUESTED, orgId, payload } };
}

/**
 * The organizations with notifications to make or send, asked outside any organization: ids
 * and nothing else (push_work_due()). With `reminders`, also those with a report to remind of.
 */
export async function pushWorkDue(db: Database, now: Date, reminders: boolean): Promise<string[]> {
  const { rows } = await db.execute<{ org_id: string }>(
    sql`select push_work_due as org_id from push_work_due(${now.toISOString()}::timestamptz, ${reminders})`,
  );
  return rows.map((r) => r.org_id);
}

/** A change on the trail, as the sweep reads it. */
interface TrailEvent {
  readonly sequence: number;
  readonly action: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown>;
  /** Done by the report schedule, not by a person. */
  readonly bySchedule: boolean;
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * What each change on the trail tells, with the names it uses and whether it still waits
 * (NotableChange). A change about something since deleted tells nothing.
 */
async function notableChanges(
  tx: Transaction,
  events: readonly TrailEvent[],
  toSubmit: boolean,
): Promise<NotableChange[]> {
  const ids = (actions: readonly string[]) => [
    ...new Set(events.filter((e) => actions.includes(e.action)).map((e) => e.entityId)),
  ];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));

  const receiptIds = ids(['receipt.read', 'receipt.possible_duplicate']);
  const receiptRows = byId(
    receiptIds.length === 0
      ? []
      : await tx
          .select({
            id: receipts.id,
            memberId: receipts.memberId,
            source: receipts.source,
            status: receipts.status,
            merchant: expenses.merchant,
          })
          .from(receipts)
          .leftJoin(
            expenses,
            and(eq(expenses.orgId, receipts.orgId), eq(expenses.id, receipts.expenseId)),
          )
          .where(inArray(receipts.id, receiptIds)),
  );
  const heldIds = new Set(
    receiptIds.length === 0
      ? []
      : (
          await tx
            .select({ id: receiptDuplicates.receiptId })
            .from(receiptDuplicates)
            .where(
              and(
                inArray(receiptDuplicates.receiptId, receiptIds),
                eq(receiptDuplicates.state, 'open'),
              ),
            )
        ).map((r) => r.id),
  );
  // Each receipt's first reading, as `receiptId:sequence`: any later one was asked for again.
  const firstReadings = new Set(
    receiptIds.length === 0
      ? []
      : (
          await tx
            .select({ id: auditEvents.entityId, first: sql<number>`min(${auditEvents.sequence})` })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.entityType, 'receipt'),
                eq(auditEvents.action, 'receipt.read'),
                inArray(auditEvents.entityId, receiptIds),
              ),
            )
            .groupBy(auditEvents.entityId)
        ).map((r) => `${r.id}:${Number(r.first)}`),
  );

  const emailIds = ids(['inbound_email.received']);
  const emailRows = byId(
    emailIds.length === 0
      ? []
      : await tx
          .select({
            id: inboundEmails.id,
            memberId: inboundEmails.memberId,
            status: inboundEmails.status,
            dismissedAt: inboundEmails.dismissedAt,
          })
          .from(inboundEmails)
          .where(inArray(inboundEmails.id, emailIds)),
  );

  const reportIds = ids([
    'report.trip_added',
    'report.closed',
    'report.submitted',
    'report.approved',
    'report.returned',
  ]);
  const reportRows = byId(
    reportIds.length === 0
      ? []
      : await tx
          .select({
            id: reports.id,
            memberId: reports.memberId,
            title: reports.title,
            status: reports.status,
            owner: members.displayName,
          })
          .from(reports)
          .innerJoin(
            members,
            and(eq(members.orgId, reports.orgId), eq(members.id, reports.memberId)),
          )
          .where(inArray(reports.id, reportIds)),
  );
  const tripIds = [
    ...new Set(
      events
        .filter((e) => e.action === 'report.trip_added')
        .map((e) => text(e.payload.tripId))
        .filter((id): id is string => id !== null),
    ),
  ];
  const tripRows = byId(
    tripIds.length === 0
      ? []
      : await tx
          .select({ id: trips.id, name: trips.name })
          .from(trips)
          .where(inArray(trips.id, tripIds)),
  );

  const expenseIds = ids(['expense.route_not_measured']);
  const driveRows = byId(
    expenseIds.length === 0
      ? []
      : await tx
          .select({
            id: expenses.id,
            memberId: expenses.memberId,
            merchant: expenses.merchant,
            status: mileageRoutes.status,
          })
          .from(expenses)
          .innerJoin(
            mileageRoutes,
            and(eq(mileageRoutes.orgId, expenses.orgId), eq(mileageRoutes.expenseId, expenses.id)),
          )
          .where(inArray(expenses.id, expenseIds)),
  );

  const statementIds = ids(['card_statement.read']);
  const statementRows = byId(
    statementIds.length === 0
      ? []
      : await tx
          .select({
            id: cardStatements.id,
            memberId: cardStatements.memberId,
            status: cardStatements.status,
          })
          .from(cardStatements)
          .where(inArray(cardStatements.id, statementIds)),
  );

  const changes: NotableChange[] = [];
  for (const e of events) {
    const sequence = e.sequence;
    switch (e.action) {
      case 'receipt.read': {
        const r = receiptRows.get(e.entityId);
        const status = text(e.payload.status);
        if (!r || !status) break;
        changes.push({
          action: 'receipt.read',
          sequence,
          receiptId: r.id,
          memberId: r.memberId,
          source: r.source,
          status,
          first: firstReadings.has(`${r.id}:${sequence}`),
          waiting: r.status === status && !heldIds.has(r.id),
          merchant: r.merchant,
        });
        break;
      }
      case 'receipt.possible_duplicate': {
        const r = receiptRows.get(e.entityId);
        if (!r) break;
        changes.push({
          action: 'receipt.possible_duplicate',
          sequence,
          receiptId: r.id,
          memberId: r.memberId,
          waiting: heldIds.has(r.id),
        });
        break;
      }
      case 'inbound_email.received': {
        const m = emailRows.get(e.entityId);
        if (!m) break;
        changes.push({
          action: 'inbound_email.received',
          sequence,
          memberId: m.memberId,
          status: m.status,
          waiting: m.dismissedAt === null,
        });
        break;
      }
      case 'report.trip_added': {
        const r = reportRows.get(e.entityId);
        const trip = tripRows.get(text(e.payload.tripId) ?? '');
        if (!r || !trip) break;
        changes.push({
          action: 'report.trip_added',
          sequence,
          reportId: r.id,
          memberId: r.memberId,
          report: r.title,
          trip: trip.name,
          bySchedule: e.bySchedule,
        });
        break;
      }
      case 'report.closed': {
        const r = reportRows.get(e.entityId);
        if (!r) break;
        changes.push({
          action: 'report.closed',
          sequence,
          reportId: r.id,
          memberId: r.memberId,
          report: r.title,
          bySchedule: e.bySchedule,
          toSubmit: toSubmit && r.status === 'closed',
        });
        break;
      }
      case 'report.submitted': {
        const r = reportRows.get(e.entityId);
        if (!r) break;
        changes.push({
          action: 'report.submitted',
          sequence,
          reportId: r.id,
          approverMemberId: text(e.payload.approverMemberId),
          selfAttests: e.payload.selfAttests === true,
          owner: r.owner,
          report: r.title,
          waiting: r.status === 'submitted' || r.status === 'in_approval',
        });
        break;
      }
      case 'report.approved':
      case 'report.returned': {
        const r = reportRows.get(e.entityId);
        if (!r) break;
        changes.push({
          action: e.action,
          sequence,
          reportId: r.id,
          memberId: r.memberId,
          report: r.title,
          bySelf:
            e.payload.selfAttested === true || text(e.payload.approverMemberId) === r.memberId,
        });
        break;
      }
      case 'expense.route_not_measured': {
        const d = driveRows.get(e.entityId);
        if (!d) break;
        changes.push({
          action: 'expense.route_not_measured',
          sequence,
          expenseId: d.id,
          memberId: d.memberId,
          drive: d.merchant ?? 'A drive',
          waiting: d.status === 'failed',
        });
        break;
      }
      case 'card_statement.read': {
        const s = statementRows.get(e.entityId);
        const status = text(e.payload.status);
        if (!s || !status) break;
        changes.push({
          action: 'card_statement.read',
          sequence,
          statementId: s.id,
          memberId: s.memberId,
          status,
          waiting: s.status === status,
        });
        break;
      }
    }
  }
  return changes;
}

/**
 * The reports members with a device still have to submit, reminded of once a day from 9:00
 * their time, from the day after each closed.
 */
async function dueReminders(
  tx: Transaction,
  now: Date,
  zones: ReadonlyMap<string, string | null>,
): Promise<NotificationDraft[]> {
  if (zones.size === 0) return [];
  const closed = await tx
    .select({
      id: reports.id,
      memberId: reports.memberId,
      title: reports.title,
      closedAt: reports.closedAt,
    })
    .from(reports)
    .where(and(eq(reports.status, 'closed'), inArray(reports.memberId, [...zones.keys()])));
  return closed.flatMap((r) => {
    const day = reminderDay(now, zones.get(r.memberId) ?? null, r.closedAt ?? now);
    return day ? [submitReminder(r.memberId, r.id, r.title, day)] : [];
  });
}

export interface PushPrepared {
  readonly read: number;
  readonly made: number;
}

/**
 * The sweep's first step for one organization, in one transaction as the system: reads the
 * trail past the cursor, makes a notification once for each person each change tells and has
 * a device and that kind on, adds the morning reminders, and moves the cursor on. With
 * notifications switched off, the cursor still moves, so nothing old is sent when they are
 * switched on. Notifications older than PUSH_KEEP_DAYS go.
 */
export function preparePush(db: Database, orgId: string, now: Date): Promise<PushPrepared> {
  return withOrg(db, orgId, async (tx) => {
    const [cursor] = await tx
      .select({ id: pushCursors.id, sequence: pushCursors.sequence })
      .from(pushCursors)
      .for('update');
    if (!cursor) return { read: 0, made: 0 };
    const rows = await tx
      .select({
        sequence: auditEvents.sequence,
        action: auditEvents.action,
        entityId: auditEvents.entityId,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          gt(auditEvents.sequence, cursor.sequence),
          inArray(auditEvents.action, [...NOTABLE_ACTIONS]),
        ),
      )
      .orderBy(asc(auditEvents.sequence))
      .limit(CHANGES_PER_SWEEP);
    const last = rows.at(-1)?.sequence;
    if (last !== undefined) {
      await tx
        .update(pushCursors)
        .set({ sequence: last, updatedAt: now })
        .where(eq(pushCursors.id, cursor.id));
    }
    await tx
      .delete(notifications)
      .where(lt(notifications.createdAt, new Date(now.getTime() - PUSH_KEEP_DAYS * 86_400_000)));
    if (!(await featureOn(tx, orgId, PUSH_FLAG))) return { read: rows.length, made: 0 };

    const devices = await tx
      .select({ memberId: pushSubscriptions.memberId, timeZone: pushSubscriptions.timeZone })
      .from(pushSubscriptions)
      .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
    // Each person's newest device sets their clock.
    const zones = new Map(devices.map((d) => [d.memberId, d.timeZone]));
    const toSubmit = await featureOn(tx, orgId, 'reports.approval');
    const events: TrailEvent[] = rows.map((r) => ({
      sequence: r.sequence,
      action: r.action,
      entityId: r.entityId,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      bySchedule: r.actorType === 'system' && r.actorId === REPORT_SCHEDULE_ID,
    }));
    const drafts = [
      ...(await notableChanges(tx, events, toSubmit)).flatMap(notificationsFor),
      ...(toSubmit ? await dueReminders(tx, now, zones) : []),
    ];
    const off = await switchedOff(tx, [...zones.keys()]);
    const wanted = drafts.filter(
      (d) => zones.has(d.memberId) && !off.has(`${d.memberId}:${d.kind}`),
    );
    if (wanted.length === 0) return { read: rows.length, made: 0 };
    const made = await tx
      .insert(notifications)
      .values(
        wanted.map((d) => ({
          orgId,
          memberId: d.memberId,
          kind: d.kind,
          dedupeKey: d.key,
          title: d.title,
          body: d.body,
          url: d.url,
          createdAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [notifications.orgId, notifications.memberId, notifications.dedupeKey],
      })
      .returning({ id: notifications.id });
    return { read: rows.length, made: made.length };
  });
}

/** One person's waiting notifications as one push, and the devices to send it to. */
export interface PendingPush {
  readonly memberId: string;
  readonly notificationIds: readonly string[];
  readonly message: PushMessage;
  readonly devices: readonly {
    readonly id: string;
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
  }[];
}

/**
 * What each person has waiting to be sent, made in the last day and tried fewer than three
 * times, as one push per person. A person with no device left has theirs given up. Call as
 * the system.
 */
export function pendingPushes(db: Database, orgId: string, now: Date): Promise<PendingPush[]> {
  return withOrg(db, orgId, async (tx) => {
    const waiting = await tx
      .select({
        id: notifications.id,
        memberId: notifications.memberId,
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        url: notifications.url,
      })
      .from(notifications)
      .where(
        and(
          isNull(notifications.sentAt),
          lt(notifications.tries, PUSH_SEND_TRIES),
          gt(notifications.createdAt, new Date(now.getTime() - SEND_WITHIN_MS)),
        ),
      )
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
    if (waiting.length === 0) return [];
    const devices = await tx
      .select({
        id: pushSubscriptions.id,
        memberId: pushSubscriptions.memberId,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.memberId, [...new Set(waiting.map((w) => w.memberId))]));
    const pushes: PendingPush[] = [];
    const orphans: string[] = [];
    for (const memberId of new Set(waiting.map((w) => w.memberId))) {
      const notes = waiting.filter((w) => w.memberId === memberId);
      const own = devices.filter((d) => d.memberId === memberId);
      if (own.length === 0) {
        orphans.push(...notes.map((n) => n.id));
        continue;
      }
      pushes.push({
        memberId,
        notificationIds: notes.map((n) => n.id),
        message: pushMessage(memberId, notes),
        devices: own.map((d) => ({
          id: d.id,
          endpoint: d.endpoint,
          keys: { p256dh: d.p256dh, auth: d.auth },
        })),
      });
    }
    if (orphans.length > 0) {
      await tx
        .update(notifications)
        .set({ tries: PUSH_SEND_TRIES })
        .where(inArray(notifications.id, orphans));
    }
    return pushes;
  });
}

/** How sending one push went, device by device. */
export interface PushOutcome {
  readonly notificationIds: readonly string[];
  /** Devices the push service took it for. */
  readonly sent: readonly string[];
  /** Devices whose subscription has ended (404, 410) or no longer fits the key (403). */
  readonly gone: readonly string[];
}

const SWEEP: AuditEntry['actor'] = { type: 'system', id: 'push-sweep' };

/**
 * Records how the pushes went: a notification any device took is sent; one none took is
 * tried once more, up to PUSH_SEND_TRIES. A device that has gone is removed, with its audit
 * event. Call as the system.
 */
export function settlePushes(
  db: Database,
  orgId: string,
  outcomes: readonly PushOutcome[],
  now: Date,
): Promise<void> {
  return withOrg(db, orgId, async (tx) => {
    const sent = outcomes.filter((o) => o.sent.length > 0).flatMap((o) => o.notificationIds);
    const failed = outcomes.filter((o) => o.sent.length === 0).flatMap((o) => o.notificationIds);
    if (sent.length > 0) {
      await tx
        .update(notifications)
        .set({ sentAt: now, tries: sql`${notifications.tries} + 1` })
        .where(inArray(notifications.id, sent));
      await tx
        .update(pushSubscriptions)
        .set({ lastSentAt: now })
        .where(inArray(pushSubscriptions.id, [...new Set(outcomes.flatMap((o) => o.sent))]));
    }
    if (failed.length > 0) {
      await tx
        .update(notifications)
        .set({ tries: sql`least(${notifications.tries} + 1, ${PUSH_SEND_TRIES})` })
        .where(inArray(notifications.id, failed));
    }
    const gone = [...new Set(outcomes.flatMap((o) => o.gone))];
    if (gone.length === 0) return;
    const removed = await tx
      .delete(pushSubscriptions)
      .where(inArray(pushSubscriptions.id, gone))
      .returning({ memberId: pushSubscriptions.memberId, endpoint: pushSubscriptions.endpoint });
    for (const device of removed) {
      await appendAuditEvent(tx, orgId, {
        actor: SWEEP,
        entityType: 'member',
        entityId: device.memberId,
        action: 'push_subscription.removed',
        payload: { service: serviceOf(device.endpoint), by: 'push service' },
      });
    }
  });
}
