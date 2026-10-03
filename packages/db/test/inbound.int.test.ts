import { newId } from '@expensewise/domain';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { memberForSender, recordInboundEmail, type NewInboundEmail } from '../src/inbound.ts';
import { auditEvents, expenses, inboundEmails, memberSignIns, receipts } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
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
