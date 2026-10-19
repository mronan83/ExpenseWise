import { isTimeZone } from './expense-details.ts';
import { dateIn, hourIn } from './time-zones.ts';

/*
 * Push notifications (FR-PLT-12, ADR-0053): what each kind is called, what a notification
 * says about each change, and how several sent at once become one. A notification says what
 * and where, never an amount (Q58), and opens what it is about.
 */

/** The kinds a person switches on or off, each its own setting (Settings › Notifications). */
export const NOTIFICATION_KINDS = [
  'receipts',
  'needs_look',
  'reports',
  'approvals',
  'decisions',
  'card',
  'drives',
  'test',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The kinds a person chooses, in the order Settings shows them; a test is always sent. */
export const CHOSEN_KINDS: readonly Exclude<NotificationKind, 'test'>[] = [
  'receipts',
  'needs_look',
  'reports',
  'approvals',
  'decisions',
  'card',
  'drives',
];

/** What each kind is called where it is switched. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  receipts: 'A receipt you emailed is filed',
  needs_look: 'A receipt or an email needs a look',
  reports: 'A trip goes on its report, a report closes, or one is ready to submit',
  approvals: 'A report is waiting for your approval',
  decisions: 'Your report is approved or comes back',
  card: 'A card statement needs a look',
  drives: 'A drive couldn’t be measured',
  test: 'A test you send yourself',
};

/** How often new changes are looked for and sent (R-PUSH-EVERY). */
export const PUSH_SWEEP = '*/5 * * * *';

/** The hour, in the organization's time zone, a report still to submit is reminded of (R-PUSH-REMINDER). */
export const SUBMIT_REMINDER_HOUR = 9;

/** Most devices one person gets notifications on; a new one past it replaces the oldest (R-PUSH-DEVICES). */
export const PUSH_DEVICES_MAX = 10;

/** How many times a notification is tried before it is given up (R-PUSH-TRIES). */
export const PUSH_SEND_TRIES = 3;

/** How long a notification is kept once made, sent or not (R-PUSH-KEEP). */
export const PUSH_KEEP_DAYS = 90;

/**
 * The push services a subscription may name (ADR-0053): Apple's, for the iPhone, and the other
 * browsers' own. The server sends to the address a browser gives it, so any other is refused,
 * and the server is never made to call somewhere else.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'push.apple.com',
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

const PUSH_ENDPOINT_MAX = 1024;

/** Whether a browser's push address is one of the push services, over HTTPS. */
export function isPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const base64urlBytes = (value: string, bytes: number) =>
  /^[A-Za-z0-9_-]+$/.test(value) && Math.floor((value.length * 3) / 4) === bytes;

/** A browser's subscription, as it gives it: where to send and the keys to encrypt with. */
export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  /** The device's time zone, for the morning reminder; dropped when not a zone. */
  readonly timeZone?: string | null;
}

export type PushSubscriptionProblem = 'endpoint' | 'keys';

/**
 * Checks a subscription before it is kept: an address at a push service, a P-256 public key
 * (65 bytes) and an authentication secret (16 bytes), each base64url.
 */
export function checkPushSubscription(
  input: PushSubscriptionInput,
):
  | { ok: true; value: PushSubscriptionInput & { timeZone: string | null } }
  | { ok: false; problem: PushSubscriptionProblem } {
  if (!isPushEndpoint(input.endpoint)) return { ok: false, problem: 'endpoint' };
  if (!base64urlBytes(input.keys.p256dh, 65) || !base64urlBytes(input.keys.auth, 16)) {
    return { ok: false, problem: 'keys' };
  }
  const zone = input.timeZone && isTimeZone(input.timeZone) ? input.timeZone : null;
  return { ok: true, value: { ...input, timeZone: zone } };
}

/**
 * Whether the morning reminder of a report still to submit is due (R-PUSH-REMINDER), and the
 * day it is for: from 9:00 on the person's device's clock, or UTC's when it isn't known, and
 * from the day after it closed, since the day it closed has its own notification.
 */
export function reminderDay(now: Date, timeZone: string | null, closedAt: Date): string | null {
  const zone = timeZone ?? 'UTC';
  const day = dateIn(now, zone);
  return hourIn(now, zone) >= SUBMIT_REMINDER_HOUR && dateIn(closedAt, zone) < day ? day : null;
}

/** Longest title and body a notification carries: what a lock screen shows in full. */
export const NOTIFICATION_TITLE_MAX = 80;
export const NOTIFICATION_BODY_MAX = 200;

/** One notification for one person, before it is sent. */
export interface NotificationDraft {
  readonly memberId: string;
  readonly kind: NotificationKind;
  /** Once per person: the same key is never sent twice. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** Where tapping it goes, in the app. */
  readonly url: string;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const draft = (d: NotificationDraft): NotificationDraft => ({
  ...d,
  title: clip(d.title, NOTIFICATION_TITLE_MAX),
  body: clip(d.body, NOTIFICATION_BODY_MAX),
});

/**
 * A change the audit trail recorded, with what a notification needs to say about it: who it
 * is for and the names it uses, never an amount. `waiting` says the thing still waits as the
 * change left it when the sweep reads it, so nobody is told of what they have already done.
 */
export type NotableChange =
  | {
      readonly action: 'receipt.read';
      readonly sequence: number;
      readonly receiptId: string;
      readonly memberId: string;
      /** How the receipt came in: one emailed is notified once read. */
      readonly source: string;
      readonly status: string;
      /** Its first reading: one read again on request is not notified. */
      readonly first: boolean;
      readonly waiting: boolean;
      readonly merchant: string | null;
    }
  | {
      readonly action: 'receipt.possible_duplicate';
      readonly sequence: number;
      readonly receiptId: string;
      readonly memberId: string;
      readonly waiting: boolean;
    }
  | {
      readonly action: 'inbound_email.received';
      readonly sequence: number;
      readonly memberId: string;
      readonly status: string;
      readonly waiting: boolean;
    }
  | {
      readonly action: 'report.trip_added';
      readonly sequence: number;
      readonly reportId: string;
      readonly memberId: string;
      readonly report: string;
      readonly trip: string;
      /** Put there by the schedule, not by the person. */
      readonly bySchedule: boolean;
    }
  | {
      readonly action: 'report.closed';
      readonly sequence: number;
      readonly reportId: string;
      readonly memberId: string;
      readonly report: string;
      readonly bySchedule: boolean;
      /** Approval is on, so the closed report is to be submitted next. */
      readonly toSubmit: boolean;
    }
  | {
      readonly action: 'report.submitted';
      readonly sequence: number;
      readonly reportId: string;
      readonly approverMemberId: string | null;
      readonly selfAttests: boolean;
      readonly owner: string;
      readonly report: string;
      readonly waiting: boolean;
    }
  | {
      readonly action: 'report.approved' | 'report.returned';
      readonly sequence: number;
      readonly reportId: string;
      readonly memberId: string;
      readonly report: string;
      /** Its own approver decided it: a one-person organization, which needs no news of it. */
      readonly bySelf: boolean;
    }
  | {
      readonly action: 'expense.route_not_measured';
      readonly sequence: number;
      readonly expenseId: string;
      readonly memberId: string;
      readonly drive: string;
      readonly waiting: boolean;
    }
  | {
      readonly action: 'card_statement.read';
      readonly sequence: number;
      readonly statementId: string;
      readonly memberId: string;
      readonly status: string;
      readonly waiting: boolean;
    };

/** The actions the audit trail is read for. */
export const NOTABLE_ACTIONS: readonly NotableChange['action'][] = [
  'receipt.read',
  'receipt.possible_duplicate',
  'inbound_email.received',
  'report.trip_added',
  'report.closed',
  'report.submitted',
  'report.approved',
  'report.returned',
  'expense.route_not_measured',
  'card_statement.read',
];

/**
 * What a change tells whom, if anyone (FR-PLT-12): a receipt emailed in and read is filed; one
 * that needs a look, may be a duplicate, or an email that filed nothing says so; a trip the
 * schedule put on a report, and a report closed on its day; a report to approve, for its
 * approver; one approved or come back; a drive not measured; a statement needing a look. What
 * and where, never an amount (Q58).
 */
export function notificationsFor(change: NotableChange): NotificationDraft[] {
  const key = `${change.action}:${change.sequence}`;
  const one = (d: Omit<NotificationDraft, 'key'>) => [draft({ ...d, key })];
  switch (change.action) {
    case 'receipt.read': {
      if (!change.first || !change.waiting) return [];
      const from = change.merchant ? ` from ${change.merchant}` : '';
      const url = `/receipts/${change.receiptId}`;
      if (change.status === 'extracted') {
        return change.source === 'email'
          ? one({
              memberId: change.memberId,
              kind: 'receipts',
              title: `Receipt${from} filed`,
              body: 'The receipt you emailed is read and filed.',
              url,
            })
          : [];
      }
      if (change.status === 'needs_review') {
        return one({
          memberId: change.memberId,
          kind: 'needs_look',
          title: `Receipt${from} needs a look`,
          body: 'Check what was read before it’s filed.',
          url,
        });
      }
      if (change.status === 'failed') {
        return one({
          memberId: change.memberId,
          kind: 'needs_look',
          title: 'A receipt couldn’t be read',
          body: 'Enter what it says, or try reading it again.',
          url,
        });
      }
      return [];
    }
    case 'receipt.possible_duplicate':
      return change.waiting
        ? one({
            memberId: change.memberId,
            kind: 'needs_look',
            title: 'A receipt may be one you already have',
            body: 'Keep both, or file it as the same purchase.',
            url: `/receipts/${change.receiptId}`,
          })
        : [];
    case 'inbound_email.received':
      return change.waiting &&
        (change.status === 'unverified' || change.status === 'no_attachments')
        ? one({
            memberId: change.memberId,
            kind: 'needs_look',
            title: 'An email you sent filed nothing',
            body:
              change.status === 'unverified'
                ? 'It couldn’t be proved to be from you. See it under Needs you.'
                : 'It had nothing to read. See it under Needs you.',
            url: '/',
          })
        : [];
    case 'report.trip_added':
      return change.bySchedule
        ? one({
            memberId: change.memberId,
            kind: 'reports',
            title: `${change.trip} is on your report`,
            body: `Your trip ended, so it went on ${change.report}.`,
            url: `/reports/${change.reportId}`,
          })
        : [];
    case 'report.closed':
      return change.bySchedule
        ? one({
            memberId: change.memberId,
            kind: 'reports',
            title: `${change.report} closed`,
            body: change.toSubmit
              ? 'It closed on its day. Submit it for approval.'
              : 'It closed on its day, with what was ready.',
            url: `/reports/${change.reportId}`,
          })
        : [];
    case 'report.submitted':
      return change.approverMemberId && !change.selfAttests && change.waiting
        ? one({
            memberId: change.approverMemberId,
            kind: 'approvals',
            title: `${change.owner}’s ${change.report} needs your approval`,
            body: 'Look it over, then approve it or send it back.',
            url: `/reports/${change.reportId}`,
          })
        : [];
    case 'report.approved':
    case 'report.returned':
      if (change.bySelf) return [];
      return one({
        memberId: change.memberId,
        kind: 'decisions',
        title:
          change.action === 'report.approved'
            ? `${change.report} is approved`
            : `${change.report} came back`,
        body:
          change.action === 'report.approved'
            ? 'Your approver approved it.'
            : 'Your approver sent it back. See why, then submit it again.',
        url: `/reports/${change.reportId}`,
      });
    case 'expense.route_not_measured':
      return change.waiting
        ? one({
            memberId: change.memberId,
            kind: 'drives',
            title: `${change.drive} couldn’t be measured`,
            body: 'See why, then measure it again or enter its miles.',
            url: `/expenses/${change.expenseId}`,
          })
        : [];
    case 'card_statement.read':
      return change.status === 'needs_look' && change.waiting
        ? one({
            memberId: change.memberId,
            kind: 'card',
            title: 'Your card statement needs a look',
            body: 'Check its charges before they are matched.',
            url: `/card#statement-${change.statementId}`,
          })
        : [];
  }
}

/** A report still to submit, reminded of once a day (FR-PLT-12, R-PUSH-REMINDER). */
export function submitReminder(
  memberId: string,
  reportId: string,
  report: string,
  day: string,
): NotificationDraft {
  return draft({
    memberId,
    kind: 'reports',
    key: `submit:${reportId}:${day}`,
    title: `${report} is ready to submit`,
    body: 'It’s closed. Submit it for approval.',
    url: `/reports/${reportId}`,
  });
}

/** What one push says, on the lock screen and when tapped. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** One per person, so a newer push replaces an older one not yet looked at. */
  readonly tag: string;
}

const KIND_COUNTS: Partial<Record<NotificationKind, (n: number) => string>> = {
  receipts: (n) => `${n} receipts filed`,
  needs_look: (n) => `${n} receipts need a look`,
  approvals: (n) => `${n} reports need your approval`,
};

/**
 * Several notifications for one person as one push (FR-PLT-12): one says itself; several of
 * one kind say how many, such as "3 receipts filed"; several kinds say how many things need
 * the person. The body names the first two and how many more; tapping opens the one place
 * they share, or Home.
 */
export function pushMessage(
  memberId: string,
  notes: readonly Pick<NotificationDraft, 'kind' | 'title' | 'body' | 'url'>[],
): PushMessage {
  const tag = `expensewise-${memberId}`;
  const [only] = notes;
  if (notes.length === 1 && only) return { title: only.title, body: only.body, url: only.url, tag };
  const kinds = new Set(notes.map((n) => n.kind));
  const urls = new Set(notes.map((n) => n.url));
  const [kind] = kinds;
  const count = kinds.size === 1 && kind ? KIND_COUNTS[kind] : undefined;
  const title = count ? count(notes.length) : `${notes.length} things need you`;
  const named = notes.slice(0, 2).map((n) => n.title);
  const more = notes.length - named.length;
  const body = clip(
    `${named.join('; ')}${more > 0 ? `, and ${more} more` : ''}.`,
    NOTIFICATION_BODY_MAX,
  );
  const [url] = urls;
  return { title, body, url: urls.size === 1 && url ? url : '/', tag };
}
