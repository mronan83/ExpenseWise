import { newId, type MemberRole } from '@expensewise/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withMember, withOrg } from '../src/client.ts';
import {
  dismissInboundEmail,
  listUnfiledEmails,
  memberForSender,
  recordInboundEmail,
  type NewInboundEmail,
} from '../src/inbound.ts';
import {
  auditEvents,
  expenses,
  inboundEmails,
  members,
  memberSignIns,
  receipts,
} from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

const email = (memberId: string, over: Partial<NewInboundEmail> = {}): NewInboundEmail => ({
  id: newId(),
  memberId,
  provider: 'bird',
  providerMessageId: `rem_${newId()}`,
  fromAddress: 'riley@example.com',
  subject: 'Your Uber receipt',
  sentAt: new Date('2026-10-03T18:00:00Z'),
  status: 'filed',
  bodyText: 'Thanks for riding.',
  ...over,
});
const attachment = (n: number) => {
  const receiptId = newId();
  return {
    receiptId,
    storageKey: `orgs/x/receipts/${receiptId}`,
    contentType: 'application/pdf',
    byteSize: 20_000 + n,
    sha256: n.toString(16).padStart(64, '0'),
  };
};

describe('finding who sent an email', () => {
  it('finds the member who signs in with the address, in any case, and no one else', async () => {
    const acme = await seedOrg(app.db, 'inbound-sender');
    expect(await memberForSender(app.db, 'Inbound-Sender@Example.com')).toEqual({
      orgId: acme.orgId,
      memberId: acme.memberId,
      userId: acme.userId,
    });
    expect(await memberForSender(app.db, 'stranger@example.com')).toBeUndefined();
  });

  it('answers with ids only: the runtime still cannot read sign-ins outside an organization', async () => {
    await seedOrg(app.db, 'inbound-private');
    const rows = await app.db.select().from(memberSignIns);
    expect(rows).toEqual([]);
  });
});

describe('keeping an email', () => {
  it('files each attachment as a receipt with its expense, and keeps the email, together', async () => {
    const acme = await seedOrg(app.db, 'inbound-file');
    const message = email(acme.memberId);
    const files = [attachment(1), attachment(2)];
    const result = await withOrg(app.db, acme.orgId, (tx) =>
      recordInboundEmail(tx, acme.orgId, message, files, acme.userId),
    );
    expect(result).toMatchObject({ status: 'recorded', receiptIds: files.map((f) => f.receiptId) });
    if (result.status !== 'recorded') return;
    expect(result.events.map((e) => e.topic)).toEqual(['receipt.uploaded', 'receipt.uploaded']);

    await withOrg(app.db, acme.orgId, async (tx) => {
      const kept = await tx.select().from(receipts);
      expect(kept.map((r) => [r.source, r.status]).sort()).toEqual([
        ['email', 'processing'],
        ['email', 'processing'],
      ]);
      expect(await tx.select().from(expenses)).toHaveLength(2);
      const [row] = await tx.select().from(inboundEmails);
      expect(row).toMatchObject({ status: 'filed', receiptCount: 2, subject: 'Your Uber receipt' });
      const audit = await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'inbound_email.received'));
      expect(audit).toHaveLength(1);
    });
  });

  it('files nothing twice when the same message is delivered again', async () => {
    const acme = await seedOrg(app.db, 'inbound-twice');
    const message = email(acme.memberId);
    const files = [attachment(3), attachment(4)];
    const keep = () =>
      withOrg(app.db, acme.orgId, (tx) =>
        recordInboundEmail(tx, acme.orgId, message, files, acme.userId),
      );
    const first = await keep();
    if (first.status !== 'recorded') throw new Error('expected the email to be recorded');
    // A retry hands on the same events again, for the receipts still waiting to be read.
    expect(await keep()).toEqual({ status: 'exists', events: first.events });
    const kept = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(receipts));
    expect(kept).toHaveLength(2);

    await withOrg(app.db, acme.orgId, (tx) =>
      tx.update(receipts).set({ status: 'extracted' }).where(eq(receipts.id, files[0]!.receiptId)),
    );
    expect(await keep()).toEqual({ status: 'exists', events: [first.events[1]] });
  });

  it('keeps an email with nothing attached, or an unverified one, without receipts', async () => {
    const acme = await seedOrg(app.db, 'inbound-bare');
    for (const status of ['no_attachments', 'unverified'] as const) {
      const result = await withOrg(app.db, acme.orgId, (tx) =>
        recordInboundEmail(
          tx,
          acme.orgId,
          email(acme.memberId, { status, bodyText: status === 'unverified' ? null : 'Total $12' }),
          [],
          acme.userId,
        ),
      );
      expect(result).toMatchObject({ status: 'recorded', receiptIds: [] });
    }
    const rows = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(inboundEmails));
    expect(rows.map((r) => [r.status, r.receiptCount]).sort()).toEqual([
      ['no_attachments', 0],
      ['unverified', 0],
    ]);
  });

  it('keeps emails inside their organization', async () => {
    const acme = await seedOrg(app.db, 'inbound-acme');
    const globex = await seedOrg(app.db, 'inbound-globex');
    await withOrg(app.db, acme.orgId, (tx) =>
      recordInboundEmail(tx, acme.orgId, email(acme.memberId), [], acme.userId),
    );
    expect(await withOrg(app.db, globex.orgId, (tx) => tx.select().from(inboundEmails))).toEqual(
      [],
    );
    // A row naming another organization is refused, as in every tenant table.
    await expectDbError(
      withOrg(app.db, globex.orgId, (tx) =>
        tx.insert(inboundEmails).values({ ...email(acme.memberId), orgId: acme.orgId }),
      ),
      /row-level security/,
    );
  });
});

/** A member added to an organization by the system, as an accepted invite would. */
async function addMember(orgId: string, name: string, role: MemberRole) {
  const memberId = newId();
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(members).values({
      id: memberId,
      orgId,
      userId: `user_${memberId}`,
      email: `${name}@example.com`,
      displayName: name,
      role,
    }),
  );
  return { orgId, memberId, role, userId: `user_${memberId}` };
}

const DAY_MS = 86_400_000;

describe('emails that filed nothing (#59)', () => {
  /** Keeps an email for a member as the workflow does, arrived `daysAgo` days ago. */
  async function keep(
    orgId: string,
    memberId: string,
    over: Partial<NewInboundEmail>,
    daysAgo = 0,
  ): Promise<string> {
    const message = email(memberId, { bodyText: null, ...over });
    await withOrg(app.db, orgId, (tx) =>
      recordInboundEmail(tx, orgId, message, [], `user_${memberId}`),
    );
    if (daysAgo > 0) {
      // When it arrived is the database's own clock; moved back as the table's owner.
      await owner.db
        .update(inboundEmails)
        .set({ createdAt: new Date(Date.now() - daysAgo * DAY_MS) })
        .where(eq(inboundEmails.id, message.id));
    }
    return message.id;
  }

  it('lists a member’s own unproved and empty emails since a time, newest first, never their text', async () => {
    const acme = await seedOrg(app.db, 'unfiled-list');
    const sam = await addMember(acme.orgId, 'unfiled-sam', 'member');
    const unproved = await keep(acme.orgId, acme.memberId, {
      status: 'unverified',
      senderProblem: 'signature_failed',
      subject: 'Fwd: Your ride',
    });
    const empty = await keep(acme.orgId, acme.memberId, { status: 'no_attachments' }, 2);
    await keep(acme.orgId, acme.memberId, { status: 'filed', bodyText: 'Total $12' });
    await keep(acme.orgId, acme.memberId, { status: 'unverified' }, 40);
    await keep(acme.orgId, sam.memberId, { status: 'no_attachments' });

    const since = new Date(Date.now() - 30 * DAY_MS);
    // The owner sees everyone's emails, and still lists only their own.
    const listed = await withMember(app.db, { ...acme, role: 'owner' }, (tx) =>
      listUnfiledEmails(tx, acme.memberId, since, 100),
    );
    expect(listed.map((e) => e.id)).toEqual([unproved, empty]);
    const [first] = listed;
    expect(first?.receivedAt).toBeInstanceOf(Date);
    expect(first).toEqual({
      id: unproved,
      status: 'unverified',
      senderProblem: 'signature_failed',
      fromAddress: 'riley@example.com',
      subject: 'Fwd: Your ride',
      receivedAt: first?.receivedAt,
    });
    expect(listed[1]).toMatchObject({ status: 'no_attachments', senderProblem: null });
    expect(listed.every((e) => !('bodyText' in e))).toBe(true);

    // Sam sees only Sam's.
    const sams = await withMember(app.db, sam, (tx) =>
      listUnfiledEmails(tx, sam.memberId, since, 100),
    );
    expect(sams).toHaveLength(1);
  });

  it('dismisses one for good, with its audit event, keeping the email as it arrived', async () => {
    const acme = await seedOrg(app.db, 'unfiled-dismiss');
    const me = { ...acme, role: 'owner' as const };
    const id = await keep(acme.orgId, acme.memberId, {
      status: 'unverified',
      senderProblem: 'not_aligned',
    });
    const since = new Date(Date.now() - 30 * DAY_MS);

    const dismiss = () =>
      withMember(app.db, me, (tx) => dismissInboundEmail(tx, acme.orgId, id, acme.userId));
    expect(await dismiss()).toBe('dismissed');
    expect(await dismiss()).toBe('already');

    await withMember(app.db, me, async (tx) => {
      expect(await listUnfiledEmails(tx, acme.memberId, since, 100)).toEqual([]);
      const [row] = await tx.select().from(inboundEmails).where(eq(inboundEmails.id, id));
      expect(row).toMatchObject({ status: 'unverified', senderProblem: 'not_aligned' });
      expect(row?.dismissedAt).toBeInstanceOf(Date);
      const audit = await tx
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.entityId, id), eq(auditEvents.action, 'inbound_email.dismissed')),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'user',
        actorId: acme.userId,
        entityType: 'inbound_email',
        payload: { status: 'unverified', problem: 'not_aligned' },
      });
    });
  });

  it('dismisses only its member’s own, and never one that filed receipts', async () => {
    const acme = await seedOrg(app.db, 'unfiled-own');
    const sam = await addMember(acme.orgId, 'unfiled-own-sam', 'member');
    const auditor = await addMember(acme.orgId, 'unfiled-own-auditor', 'auditor');
    const sams = await keep(acme.orgId, sam.memberId, { status: 'no_attachments' });
    const auditors = await keep(acme.orgId, auditor.memberId, { status: 'no_attachments' });
    const filed = await keep(acme.orgId, acme.memberId, { status: 'filed', bodyText: 'Hi' });

    // Riley, an owner, sees Sam's email but can't dismiss it; Sam can't even see Riley's.
    await expectDbError(
      withMember(app.db, { ...acme, role: 'owner' }, (tx) =>
        dismissInboundEmail(tx, acme.orgId, sams, acme.userId),
      ),
      /own_records/,
    );
    const rileys = await keep(acme.orgId, acme.memberId, { status: 'no_attachments' });
    expect(
      await withMember(app.db, sam, (tx) =>
        dismissInboundEmail(tx, acme.orgId, rileys, sam.userId),
      ),
    ).toBe('missing');
    // An auditor changes nothing, not even their own (ADR-0035).
    await expectDbError(
      withMember(app.db, auditor, (tx) =>
        dismissInboundEmail(tx, acme.orgId, auditors, auditor.userId),
      ),
      /own_records/,
    );
    expect(
      await withMember(app.db, { ...acme, role: 'owner' }, (tx) =>
        dismissInboundEmail(tx, acme.orgId, filed, acme.userId),
      ),
    ).toBe('missing');
    expect(
      await withMember(app.db, sam, (tx) => dismissInboundEmail(tx, acme.orgId, sams, sam.userId)),
    ).toBe('dismissed');
  });

  it('never lets the app clear a dismissal, or change anything else about an email', async () => {
    const acme = await seedOrg(app.db, 'unfiled-locked');
    const id = await keep(acme.orgId, acme.memberId, { status: 'no_attachments' });
    await withOrg(app.db, acme.orgId, (tx) => dismissInboundEmail(tx, acme.orgId, id, acme.userId));
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.update(inboundEmails).set({ dismissedAt: null }).where(eq(inboundEmails.id, id)),
      ),
      /stays dismissed/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.update(inboundEmails).set({ subject: 'Changed' }).where(eq(inboundEmails.id, id)),
      ),
      /permission denied/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.execute(sql`delete from inbound_emails where id = ${id}`),
      ),
      /permission denied/,
    );
  });

  it('keeps why a sender wasn’t proved only for an unproved email, and dismisses none filed', async () => {
    const acme = await seedOrg(app.db, 'unfiled-checks');
    await expectDbError(
      keep(acme.orgId, acme.memberId, { status: 'filed', senderProblem: 'unsigned' }),
      /inbound_emails_problem_unverified/,
    );
    const filed = await keep(acme.orgId, acme.memberId, { status: 'filed' });
    await expectDbError(
      owner.db
        .update(inboundEmails)
        .set({ dismissedAt: new Date() })
        .where(eq(inboundEmails.id, filed)),
      /inbound_emails_dismissed_unfiled/,
    );
  });
});
