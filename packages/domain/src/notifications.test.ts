import { describe, expect, it } from 'vitest';
import {
  checkPushSubscription,
  CHOSEN_KINDS,
  isPushEndpoint,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_TITLE_MAX,
  notificationsFor,
  pushMessage,
  reminderDay,
  submitReminder,
  type NotableChange,
} from './notifications.ts';

const MEMBER = '00000000-0000-4000-8000-000000000001';
const APPROVER = '00000000-0000-4000-8000-000000000002';

const receipt = (over: Partial<Extract<NotableChange, { action: 'receipt.read' }>> = {}) =>
  ({
    action: 'receipt.read',
    sequence: 7,
    receiptId: 'r1',
    memberId: MEMBER,
    source: 'email',
    status: 'extracted',
    first: true,
    waiting: true,
    merchant: 'Delta',
    ...over,
  }) satisfies NotableChange;

describe('what each change tells whom (FR-PLT-12)', () => {
  it('tells of a receipt emailed in and filed, by its merchant, opening it', () => {
    expect(notificationsFor(receipt())).toEqual([
      {
        memberId: MEMBER,
        kind: 'receipts',
        key: 'receipt.read:7',
        title: 'Receipt from Delta filed',
        body: 'The receipt you emailed is read and filed.',
        url: '/receipts/r1',
      },
    ]);
    expect(notificationsFor(receipt({ merchant: null }))[0]?.title).toBe('Receipt filed');
  });

  it('says nothing of a receipt the person took or uploaded, read again, or already looked at', () => {
    expect(notificationsFor(receipt({ source: 'camera' }))).toEqual([]);
    expect(notificationsFor(receipt({ first: false }))).toEqual([]);
    expect(notificationsFor(receipt({ waiting: false }))).toEqual([]);
    expect(notificationsFor(receipt({ status: 'processing' }))).toEqual([]);
  });

  it('tells of a receipt that needs a look or couldn’t be read, however it came in', () => {
    const look = notificationsFor(receipt({ status: 'needs_review', source: 'camera' }));
    expect(look).toMatchObject([{ kind: 'needs_look', title: 'Receipt from Delta needs a look' }]);
    const failed = notificationsFor(receipt({ status: 'failed', merchant: null }));
    expect(failed).toMatchObject([{ kind: 'needs_look', title: 'A receipt couldn’t be read' }]);
  });

  it('tells of a possible duplicate and an email that filed nothing, while they wait', () => {
    const duplicate = {
      action: 'receipt.possible_duplicate',
      sequence: 8,
      receiptId: 'r2',
      memberId: MEMBER,
      waiting: true,
    } as const;
    expect(notificationsFor(duplicate)).toMatchObject([
      { kind: 'needs_look', url: '/receipts/r2', key: 'receipt.possible_duplicate:8' },
    ]);
    expect(notificationsFor({ ...duplicate, waiting: false })).toEqual([]);
    const email = {
      action: 'inbound_email.received',
      sequence: 9,
      memberId: MEMBER,
      status: 'no_attachments',
      waiting: true,
    } as const;
    expect(notificationsFor(email)).toMatchObject([
      { kind: 'needs_look', title: 'An email you sent filed nothing', url: '/' },
    ]);
    expect(notificationsFor({ ...email, status: 'filed' })).toEqual([]);
    expect(notificationsFor({ ...email, waiting: false })).toEqual([]);
  });

  it('tells of a trip and a report the schedule moved, not of what the person did', () => {
    const trip = {
      action: 'report.trip_added',
      sequence: 10,
      reportId: 'p1',
      memberId: MEMBER,
      report: 'October report',
      trip: 'Chicago',
      bySchedule: true,
    } as const;
    expect(notificationsFor(trip)).toMatchObject([
      {
        kind: 'reports',
        title: 'Chicago is on your report',
        body: 'Your trip ended, so it went on October report.',
        url: '/reports/p1',
      },
    ]);
    expect(notificationsFor({ ...trip, bySchedule: false })).toEqual([]);
    const closed = {
      action: 'report.closed',
      sequence: 11,
      reportId: 'p1',
      memberId: MEMBER,
      report: 'October report',
      bySchedule: true,
      toSubmit: true,
    } as const;
    expect(notificationsFor(closed)).toMatchObject([
      { title: 'October report closed', body: 'It closed on its day. Submit it for approval.' },
    ]);
    expect(notificationsFor({ ...closed, toSubmit: false })[0]?.body).toBe(
      'It closed on its day, with what was ready.',
    );
    expect(notificationsFor({ ...closed, bySchedule: false })).toEqual([]);
  });

  it('tells an approver of a report to approve, unless it self-attests or was decided', () => {
    const submitted = {
      action: 'report.submitted',
      sequence: 12,
      reportId: 'p1',
      approverMemberId: APPROVER,
      selfAttests: false,
      owner: 'Alex Kim',
      report: 'October report',
      waiting: true,
    } as const;
    expect(notificationsFor(submitted)).toMatchObject([
      {
        memberId: APPROVER,
        kind: 'approvals',
        title: 'Alex Kim’s October report needs your approval',
      },
    ]);
    expect(notificationsFor({ ...submitted, selfAttests: true })).toEqual([]);
    expect(notificationsFor({ ...submitted, approverMemberId: null })).toEqual([]);
    expect(notificationsFor({ ...submitted, waiting: false })).toEqual([]);
  });

  it('tells the owner of a report approved or come back, except one they decided themselves', () => {
    const approved = {
      action: 'report.approved',
      sequence: 13,
      reportId: 'p1',
      memberId: MEMBER,
      report: 'October report',
      bySelf: false,
    } as const;
    expect(notificationsFor(approved)).toMatchObject([
      { kind: 'decisions', title: 'October report is approved' },
    ]);
    expect(notificationsFor({ ...approved, action: 'report.returned' })).toMatchObject([
      { title: 'October report came back', key: 'report.returned:13' },
    ]);
    expect(notificationsFor({ ...approved, bySelf: true })).toEqual([]);
  });

  it('tells of a drive not measured and a statement that needs a look, while they wait', () => {
    const drive = {
      action: 'expense.route_not_measured',
      sequence: 14,
      expenseId: 'e1',
      memberId: MEMBER,
      drive: 'Office → Acme HQ',
      waiting: true,
    } as const;
    expect(notificationsFor(drive)).toMatchObject([
      { kind: 'drives', title: 'Office → Acme HQ couldn’t be measured', url: '/expenses/e1' },
    ]);
    expect(notificationsFor({ ...drive, waiting: false })).toEqual([]);
    const statement = {
      action: 'card_statement.read',
      sequence: 15,
      statementId: 's1',
      memberId: MEMBER,
      status: 'needs_look',
      waiting: true,
    } as const;
    expect(notificationsFor(statement)).toMatchObject([
      { kind: 'card', url: '/card#statement-s1' },
    ]);
    expect(notificationsFor({ ...statement, status: 'read' })).toEqual([]);
  });

  it('never says an amount, and fits what a lock screen shows', () => {
    const long = 'A'.repeat(300);
    const [note] = notificationsFor(receipt({ merchant: long }));
    expect(note!.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
    expect(note!.title.endsWith('…')).toBe(true);
    const all = [
      ...notificationsFor(receipt()),
      ...notificationsFor(receipt({ status: 'needs_review' })),
      submitReminder(MEMBER, 'p1', 'October report', '2026-10-19'),
    ];
    for (const n of all) {
      expect(`${n.title} ${n.body}`).not.toMatch(/[$€£¥]|\d+\.\d{2}/);
      expect(n.body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
    }
  });
});

describe('a report still to submit (R-PUSH-REMINDER)', () => {
  it('is reminded of once a day, by its key', () => {
    const today = submitReminder(MEMBER, 'p1', 'October report', '2026-10-19');
    expect(today).toEqual({
      memberId: MEMBER,
      kind: 'reports',
      key: 'submit:p1:2026-10-19',
      title: 'October report is ready to submit',
      body: 'It’s closed. Submit it for approval.',
      url: '/reports/p1',
    });
    expect(submitReminder(MEMBER, 'p1', 'October report', '2026-10-20').key).not.toBe(today.key);
  });
});

describe('several notifications as one push (US-INBOX-03 AC6)', () => {
  const filed = (merchant: string, id: string) =>
    notificationsFor(receipt({ merchant, receiptId: id }))[0]!;

  it('sends one as itself, tagged for its person', () => {
    const one = filed('Delta', 'r1');
    expect(pushMessage(MEMBER, [one])).toEqual({
      title: one.title,
      body: one.body,
      url: one.url,
      tag: `expensewise-${MEMBER}`,
    });
  });

  it('says how many of one kind, names the first two, and opens Home when they differ', () => {
    const message = pushMessage(MEMBER, [
      filed('Delta', 'r1'),
      filed('Hilton', 'r2'),
      filed('Uber', 'r3'),
    ]);
    expect(message).toEqual({
      title: '3 receipts filed',
      body: 'Receipt from Delta filed; Receipt from Hilton filed, and 1 more.',
      url: '/',
      tag: `expensewise-${MEMBER}`,
    });
  });

  it('says how many things need the person when the kinds differ, opening what they share', () => {
    const report = submitReminder(MEMBER, 'p1', 'October report', '2026-10-19');
    const message = pushMessage(MEMBER, [report, { ...report, kind: 'decisions' }]);
    expect(message.title).toBe('2 things need you');
    expect(message.url).toBe('/reports/p1');
  });
});

describe('the kinds a person switches', () => {
  it('names every kind, and lets a person choose each but the test', () => {
    for (const kind of NOTIFICATION_KINDS) expect(NOTIFICATION_KIND_LABELS[kind]).toBeTruthy();
    expect(CHOSEN_KINDS).toEqual(NOTIFICATION_KINDS.filter((k) => k !== 'test'));
  });
});

describe('a browser’s subscription (ADR-0053)', () => {
  const keys = { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) };

  it('names a push service over HTTPS, and nowhere else the server could be sent', () => {
    expect(isPushEndpoint('https://web.push.apple.com/QGuQ2sp')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('http://web.push.apple.com/x')).toBe(false);
    expect(isPushEndpoint('https://web.push.apple.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://push.apple.com.example.com/x')).toBe(false);
    expect(isPushEndpoint('https://evilpush.apple.com.attacker.net/x')).toBe(false);
    expect(isPushEndpoint('https://user@web.push.apple.com/x')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
    expect(isPushEndpoint(`https://web.push.apple.com/${'x'.repeat(1100)}`)).toBe(false);
  });

  it('carries a 65-byte key and a 16-byte secret, and a time zone only when it is one', () => {
    const endpoint = 'https://web.push.apple.com/QGuQ2sp';
    expect(checkPushSubscription({ endpoint, keys, timeZone: 'America/Chicago' })).toEqual({
      ok: true,
      value: { endpoint, keys, timeZone: 'America/Chicago' },
    });
    expect(checkPushSubscription({ endpoint, keys, timeZone: 'Mars/Olympus' })).toMatchObject({
      ok: true,
      value: { timeZone: null },
    });
    expect(checkPushSubscription({ endpoint, keys: { ...keys, auth: 'A'.repeat(21) } })).toEqual({
      ok: false,
      problem: 'keys',
    });
    expect(
      checkPushSubscription({ endpoint, keys: { ...keys, p256dh: 'not base64url!' } }),
    ).toEqual({ ok: false, problem: 'keys' });
    expect(checkPushSubscription({ endpoint: 'https://example.com/x', keys })).toEqual({
      ok: false,
      problem: 'endpoint',
    });
  });
});

describe('the morning reminder (R-PUSH-REMINDER)', () => {
  const closed = new Date('2026-10-18T20:00:00Z');

  it('is due from 9:00 on the person’s clock, for that day', () => {
    // 13:59 UTC is 8:59 in Chicago in October (UTC−5).
    expect(reminderDay(new Date('2026-10-19T13:59:00Z'), 'America/Chicago', closed)).toBeNull();
    expect(reminderDay(new Date('2026-10-19T14:00:00Z'), 'America/Chicago', closed)).toBe(
      '2026-10-19',
    );
    // 03:00 UTC on the 20th is still the 19th in Chicago, after 9:00.
    expect(reminderDay(new Date('2026-10-20T03:00:00Z'), 'America/Chicago', closed)).toBe(
      '2026-10-19',
    );
    expect(reminderDay(new Date('2026-10-19T08:00:00Z'), null, closed)).toBeNull();
    expect(reminderDay(new Date('2026-10-19T09:00:00Z'), null, closed)).toBe('2026-10-19');
  });

  it('waits for the day after the report closed, which had its own notification', () => {
    const closedThisMorning = new Date('2026-10-19T13:00:00Z');
    expect(
      reminderDay(new Date('2026-10-19T15:00:00Z'), 'America/Chicago', closedThisMorning),
    ).toBeNull();
    expect(
      reminderDay(new Date('2026-10-20T14:00:00Z'), 'America/Chicago', closedThisMorning),
    ).toBe('2026-10-20');
  });
});
