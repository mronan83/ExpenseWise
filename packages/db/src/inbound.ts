import { and, eq, inArray, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Database, Transaction } from './client.ts';
import { fileReceipt, RECEIPT_UPLOADED, type CommittedEvent } from './receipts.ts';
import { inboundEmails, outboxEvents, receipts, type inboundEmailStatus } from './schema.ts';

export type InboundEmailStatus = (typeof inboundEmailStatus.enumValues)[number];

/** The member an email's sender signs in as, and the sign-in's user, who files it. */
export interface Sender {
  readonly orgId: string;
  readonly memberId: string;
  readonly userId: string;
}

/**
 * Who signs in with this address (ADR-0026). Asked outside any organization, since an
 * arriving email names none: the database answers with ids and nothing else.
 */
export async function memberForSender(db: Database, email: string): Promise<Sender | undefined> {
  const { rows } = await db.execute<{ org_id: string; member_id: string; user_id: string }>(
    sql`select org_id, member_id, user_id from member_for_sign_in_email(${email})`,
  );
  const [row] = rows;
  return row ? { orgId: row.org_id, memberId: row.member_id, userId: row.user_id } : undefined;
}

export interface NewInboundEmail {
  readonly id: string;
  readonly memberId: string;
  /** Who delivered it, and their id for the message. */
  readonly provider: string;
  readonly providerMessageId: string;
  readonly fromAddress: string;
  readonly subject: string | null;
  readonly sentAt: Date | null;
  readonly status: InboundEmailStatus;
  /** Kept only for a verified sender, at most 64 KiB. */
  readonly bodyText: string | null;
}

/** An attachment already stored where its receipt will point. */
export interface InboundAttachment {
  readonly receiptId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export type RecordInboundEmailResult =
  | {
      readonly status: 'recorded';
      readonly receiptIds: string[];
      readonly events: CommittedEvent[];
    }
  | {
      readonly status: 'exists';
      /** The upload events of its receipts that are still waiting to be read. */
      readonly events: CommittedEvent[];
    };

/**
 * The upload events of these receipts, for those still processing. A step that kept an
 * email and failed before handing its events on is retried, finds the email kept, and sends
 * these again: the runner drops an event id it has seen, and a receipt already read is left
 * out.
 */
async function waitingUploadEvents(
  tx: Transaction,
  orgId: string,
  receiptIds: readonly string[],
): Promise<CommittedEvent[]> {
  if (receiptIds.length === 0) return [];
  const rows = await tx
    .select({ id: outboxEvents.id, payload: outboxEvents.payload })
    .from(outboxEvents)
    .innerJoin(receipts, eq(receipts.id, sql`(${outboxEvents.payload}->>'receiptId')::uuid`))
    .where(
      and(
        eq(outboxEvents.topic, RECEIPT_UPLOADED),
        inArray(receipts.id, [...receiptIds]),
        eq(receipts.status, 'processing'),
      ),
    )
    .orderBy(outboxEvents.createdAt, outboxEvents.id);
  return rows.map((r) => ({
    outboxId: r.id,
    topic: RECEIPT_UPLOADED,
    orgId,
    payload: r.payload as Record<string, unknown>,
  }));
}

/**
 * Keeps an email and files each of its attachments as a receipt, with the receipt's expense,
 * outbox event and audit events, in one transaction. Call inside withOrg(). A message already
 * kept is left alone, so a delivery tried twice files nothing twice; a file already filed
 * stays the receipt it was. Attachment ids must be the same on every try (ADR-0026).
 */
export async function recordInboundEmail(
  tx: Transaction,
  orgId: string,
  email: NewInboundEmail,
  attachments: readonly InboundAttachment[],
  actorUserId: string,
): Promise<RecordInboundEmailResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inbound:${orgId}:${email.provider}:${email.providerMessageId}`}, 0))`,
  );
  const [kept] = await tx
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.provider, email.provider),
        eq(inboundEmails.providerMessageId, email.providerMessageId),
      ),
    );
  if (kept) {
    const ids = attachments.map((a) => a.receiptId);
    return { status: 'exists', events: await waitingUploadEvents(tx, orgId, ids) };
  }

  const receiptIds: string[] = [];
  const events: CommittedEvent[] = [];
  for (const file of attachments) {
    const filed = await fileReceipt(
      tx,
      orgId,
      {
        id: file.receiptId,
        memberId: email.memberId,
        source: 'email',
        storageKey: file.storageKey,
        contentType: file.contentType,
        byteSize: file.byteSize,
        sha256: file.sha256,
      },
      actorUserId,
    );
    if (filed.status === 'filed') {
      receiptIds.push(filed.receipt.id);
      events.push(filed.event);
    }
  }
  await tx.insert(inboundEmails).values({ ...email, orgId, receiptCount: receiptIds.length });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'inbound_email',
    entityId: email.id,
    action: 'inbound_email.received',
    payload: {
      provider: email.provider,
      status: email.status,
      attachments: attachments.length,
      receiptIds,
    },
  });
  return { status: 'recorded', receiptIds, events };
}
