import type {
  DismissEmailResult,
  ExpenseRecord,
  Membership,
  ReceiptRecord,
  UnfiledEmailRecord,
} from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { HomeStore } from '../src/home.ts';
import type { ReceiptStore } from '../src/receipts.ts';
import type { NeedsYouOptions, ReportStore, ReportsNeedingYou } from '../src/reports.ts';
import type { UnfiledEmailStore } from '../src/unfiled-emails.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const RILEY = '0192f7a0-0000-7000-8000-0000000000b1';
const RECEIPT = '0192f7a0-0000-7000-8000-0000000000d1';
const COFFEE = '0192f7a0-0000-7000-8000-0000000000e1';
const UNPROVED = '0192f7a0-0000-7000-8000-0000000000f1';
const EMPTY = '0192f7a0-0000-7000-8000-0000000000f2';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const FLAG = 'receipts.unfiled-emails';

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const failed: ReceiptRecord = {
  id: RECEIPT,
  memberId: RILEY,
  uploadedBy: 'riley',
  source: 'camera',
  storageKey: `orgs/${ORG}/receipts/${RECEIPT}`,
  contentType: 'image/jpeg',
  byteSize: 40_000,
  sha256: 'c'.repeat(64),
  status: 'failed',
  expenseId: null,
  createdAt: NOW,
};

const coffee = {
  id: COFFEE,
  memberId: RILEY,
  owner: 'riley',
  status: 'ready',
  source: 'manual',
  merchant: 'Blue Bottle Coffee',
  transactionDate: '2026-10-02',
  currency: 'USD',
  amountMinor: 650,
  receiptId: null,
  tripId: null,
  justification: null,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as ExpenseRecord;

const emails: UnfiledEmailRecord[] = [
  {
    id: UNPROVED,
    status: 'unverified',
    senderProblem: 'signature_failed',
    fromAddress: 'riley@example.com',
    subject: 'Fwd: Your Tuesday evening trip',
    receivedAt: new Date('2026-10-04T18:00:00.000Z'),
  },
  {
    id: EMPTY,
    status: 'no_attachments',
    senderProblem: null,
    fromAddress: 'riley@example.com',
    subject: null,
    receivedAt: new Date('2026-10-01T09:30:00.000Z'),
  },
];

/**
 * Needs you with a receipt nothing could read, a local coffee with no reason yet, and, when
 * asked, two of Riley's emails that filed nothing: one changed after it was signed, and one
 * with nothing in it.
 */
function setup(
  options: {
    flags?: string;
    store?: boolean;
    dismissed?: DismissEmailResult | Error;
    role?: Membership['role'];
  } = {},
) {
  const asked: (NeedsYouOptions | undefined)[] = [];
  const answer = (o?: NeedsYouOptions): ReportsNeedingYou => {
    asked.push(o);
    return { reports: [], unjustified: [coffee], ...(o?.unfiledSince ? { emails } : {}) };
  };
  const dismissals: { orgId: string; emailId: string; actor: string }[] = [];
  const store: UnfiledEmailStore = {
    dismiss: (orgId, emailId, actor) => {
      dismissals.push({ orgId, emailId, actor });
      const result = options.dismissed ?? 'dismissed';
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  const home: HomeStore = {
    snapshot: (_org, _member, _day, _limit, o) =>
      Promise.resolve({
        home: {
          tripNow: null,
          tripNext: null,
          recentTrips: [],
          tallies: [],
          month: { from: '2026-10-01', until: '2026-11-01' },
          monthExpenses: [],
          monthTrips: 0,
          reading: 0,
        },
        receipts: [failed],
        runs: [],
        reviews: [],
        pairs: [],
        reports: answer(o),
      }),
  };
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) =>
        Promise.resolve(
          userId === 'riley'
            ? { orgId: ORG, memberId: RILEY, role: options.role ?? 'owner' }
            : undefined,
        ),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    receipts: {
      list: () => Promise.resolve({ receipts: [failed], runs: [], reviews: [], pairs: [] }),
    } as unknown as ReceiptStore,
    reports: {
      needsYou: (_org: string, _member: string, _limit: number, o?: NeedsYouOptions) =>
        Promise.resolve(answer(o)),
    } as unknown as ReportStore,
    home,
    emails: options.store === false ? undefined : store,
    flagOverrides: options.flags ?? `${FLAG}=on`,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who: string | null = 'riley') => {
    const res = await api.request(path, {
      method,
      headers: who ? { authorization: `Bearer ${who}` } : {},
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  };
  return { call, asked, dismissals };
}

interface Item {
  kind: string;
  reason: { code: string; problem?: string | null };
  email?: Record<string, unknown>;
}
interface Body {
  items?: Item[];
  needsYou?: { count: number; items: Item[] };
  code?: string;
}

const dismiss = (id: string) => `/v1/inbox/emails/${id}/dismiss`;

describe('emails that filed nothing, in Needs you (#59)', () => {
  it('lists the member’s own after receipts, newest first, with why and never their text', async () => {
    const { call, asked } = setup();
    const { status, body } = await call('GET', '/v1/inbox');
    expect(status).toBe(200);
    // Since 30 days before now, for the caller.
    expect(asked).toEqual([{ uncoded: false, unfiledSince: new Date('2026-09-05T12:00:00.000Z') }]);
    expect(body.items?.map((i) => [i.kind, i.reason.code])).toEqual([
      ['receipt', 'failed'],
      ['email', 'unproved'],
      ['email', 'empty'],
      ['expense', 'justification'],
    ]);
    expect(body.items?.[1]).toEqual({
      kind: 'email',
      email: {
        id: UNPROVED,
        subject: 'Fwd: Your Tuesday evening trip',
        from: 'riley@example.com',
        receivedAt: '2026-10-04T18:00:00.000Z',
      },
      reason: { code: 'unproved', problem: 'signature_failed' },
    });
    expect(body.items?.[2]).toEqual({
      kind: 'email',
      email: {
        id: EMPTY,
        subject: null,
        from: 'riley@example.com',
        receivedAt: '2026-10-01T09:30:00.000Z',
      },
      reason: { code: 'empty', problem: null },
    });
  });

  it('counts them on Home, as the inbox lists them', async () => {
    const { call, asked } = setup();
    const { status, body } = await call('GET', '/v1/home?day=2026-10-05');
    expect(status).toBe(200);
    expect(asked[0]?.unfiledSince).toEqual(new Date('2026-09-05T12:00:00.000Z'));
    expect(body.needsYou?.count).toBe(4);
    expect(body.needsYou?.items.map((i) => i.reason.code)).toEqual(['failed', 'unproved', 'empty']);
  });

  it('dismisses one for the caller, and answers the same when it was dismissed already', async () => {
    const s = setup();
    expect((await s.call('POST', dismiss(UNPROVED))).status).toBe(204);
    expect(s.dismissals).toEqual([{ orgId: ORG, emailId: UNPROVED, actor: 'riley' }]);
    expect((await setup({ dismissed: 'already' }).call('POST', dismiss(UNPROVED))).status).toBe(
      204,
    );
  });

  it('answers 404 for no such email, or one that filed receipts, and 400 for an id that is not one', async () => {
    const missing = await setup({ dismissed: 'missing' }).call('POST', dismiss(EMPTY));
    expect(missing).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect((await setup().call('POST', dismiss('not-an-id'))).status).toBe(400);
  });

  it('answers 403 not_yours when the database refuses: someone else’s, or an auditor', async () => {
    const refusal = Object.assign(
      new Error('own_records: as auditor, this member may not change that inbound_emails row'),
      { code: '42501' },
    );
    const { status, body } = await setup({ dismissed: refusal, role: 'auditor' }).call(
      'POST',
      dismiss(UNPROVED),
    );
    expect(status).toBe(403);
    expect(body.code).toBe('not_yours');
  });

  it('needs a signed-in member, and a database to dismiss with', async () => {
    expect((await setup().call('POST', dismiss(UNPROVED), null)).status).toBe(401);
    expect((await setup().call('POST', dismiss(UNPROVED), 'stranger')).status).toBe(403);
    const none = await setup({ store: false }).call('POST', dismiss(UNPROVED));
    expect(none).toMatchObject({ status: 503, body: { code: 'database_not_configured' } });
  });

  it.each([`${FLAG}=off`, ''])(
    'leaves Needs you as it was, and dismisses nothing, with the feature off (%s)',
    async (flags) => {
      const { call, asked, dismissals } = setup({ flags });
      const inbox = await call('GET', '/v1/inbox');
      expect(inbox.body.items?.map((i) => i.kind)).toEqual(['receipt', 'expense']);
      const home = await call('GET', '/v1/home?day=2026-10-05');
      expect(home.body.needsYou?.count).toBe(2);
      expect(asked).toEqual([{ uncoded: false }, { uncoded: false }]);
      const off = await call('POST', dismiss(UNPROVED));
      expect(off).toMatchObject({ status: 404, body: { code: 'feature_off' } });
      expect(dismissals).toEqual([]);
    },
  );

  it('reads no emails where they can’t be shown, even with the feature on', async () => {
    const { call, asked } = setup({ store: false });
    const inbox = await call('GET', '/v1/inbox');
    expect(inbox.body.items?.map((i) => i.kind)).toEqual(['receipt', 'expense']);
    expect(asked).toEqual([{ uncoded: false }]);
  });
});
