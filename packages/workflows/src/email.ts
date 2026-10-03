import { createHash } from 'node:crypto';
import type {
  CommittedEvent,
  InboundAttachment,
  InboundEmailStatus,
  NewInboundEmail,
  RecordInboundEmailResult,
  Sender,
} from '@expensewise/db';
import { derivedId } from '@expensewise/domain';
import type { DocumentMediaType } from '@expensewise/extraction';
import { receiptPath, RECEIPT_MAX_BYTES } from '@expensewise/storage';
import { NonRetriableError, type Inngest } from 'inngest';
import type { DNSResolver } from 'mailauth';
import { dkimVerify } from 'mailauth/lib/dkim/verify';
import PostalMime, { type Attachment } from 'postal-mime';
import { emailAsPdf, htmlAsText } from './email-pdf.ts';
import { sniffMediaType } from './receipts.ts';
import { committedWorkflowEvent } from './relay.ts';

/** Sent by the inbound webhook for each email that arrives (ADR-0026). */
export const EMAIL_RECEIVED = 'email/received';

/** An email the provider holds for us, named the way its API finds it again. */
export interface ReceivedEmail {
  readonly provider: 'bird';
  readonly messageId: string;
  readonly threadId: string;
}

/** At most this many receipts from one email, so one message can't run up reading costs. */
export const MAX_RECEIPTS_PER_EMAIL = 10;
/** Smaller pictures are logos, icons and tracking pixels, never a readable receipt. */
export const MIN_PICTURE_BYTES = 16 * 1024;
/**
 * A picture the email's own HTML shows (by Content-ID) is usually its layout: a logo or a
 * banner. A photo of a receipt pasted into the message is far bigger than this.
 */
export const MIN_LAYOUT_PICTURE_BYTES = 128 * 1024;
/** The body text kept for a verified sender, for reading purchase summaries later. */
export const BODY_TEXT_LIMIT_BYTES = 64 * 1024;

export type SenderProblem =
  /** No From address, or more than one: there is no one author to check. */
  | 'no_single_author'
  /** No DKIM signature at all. */
  | 'unsigned'
  /** Signed, but no signature checks out. */
  | 'signature_failed'
  /** A good signature, but by a domain other than the From address's. */
  | 'not_aligned'
  /** A good, aligned signature that leaves part of the body unsigned (l=). */
  | 'partly_signed';

/** Who an email says it is from, and whether its signature proves it. */
export type SenderCheck =
  | { readonly verified: true; readonly address: string; readonly signingDomain: string }
  | { readonly verified: false; readonly address: string | null; readonly problem: SenderProblem };

/**
 * Checks the From address against the email's DKIM signatures (ADR-0026). The address is
 * proved only by a passing signature of the From domain itself, or of a domain in the same
 * organization (relaxed alignment, as DMARC has it), that covers the whole body. The envelope
 * sender and SPF prove nothing about From and are not used. Throws, so the step is retried,
 * when nothing proves the sender and a key lookup failed for now.
 */
export async function checkSender(
  raw: Uint8Array,
  options: { resolver?: DNSResolver; now?: Date } = {},
): Promise<SenderCheck> {
  const result = await dkimVerify(Buffer.from(raw), {
    ...(options.resolver ? { resolver: options.resolver } : {}),
    curTime: options.now ?? new Date(),
  });
  const authors = result.fromFields === 1 ? result.headerFrom : [];
  if (authors.length !== 1) {
    return { verified: false, address: null, problem: 'no_single_author' };
  }
  const address = authors[0]!.toLowerCase();
  const passing = result.results.filter((r) => r.status.result === 'pass');
  const aligned = passing.filter((r) => r.status.aligned);
  const whole = aligned.find((r) => !r.status.underSized);
  if (whole) return { verified: true, address, signingDomain: whole.signingDomain ?? '' };
  // A key that couldn't be looked up for now says nothing about the sender: try again later
  // rather than keep a member's email as unverified for good.
  const unsure = result.results.find((r) => ['temperror', 'temperr'].includes(r.status.result));
  if (unsure) {
    throw new Error(`A DKIM key lookup failed for now (${unsure.status.comment ?? 'DNS'})`);
  }
  const problem: SenderProblem =
    aligned.length > 0
      ? 'partly_signed'
      : passing.length > 0
        ? 'not_aligned'
        : result.results.some((r) => r.signingDomain)
          ? 'signature_failed'
          : 'unsigned';
  return { verified: false, address, problem };
}

/** A file from an email that can be filed as a receipt. */
export interface EmailFile {
  readonly bytes: Uint8Array;
  readonly contentType: DocumentMediaType;
  readonly sha256: string;
}

export interface ParsedEmail {
  readonly subject: string | null;
  readonly sentAt: Date | null;
  /** The HTML as text, or the plain part when there is no HTML, at most 64 KiB. */
  readonly bodyText: string | null;
  readonly files: EmailFile[];
  /** Attachments not taken: unsupported, too small or too big, repeated, or over the limit. */
  readonly skipped: number;
}

const bytesOf = (content: Attachment['content']): Uint8Array =>
  typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

/** The first `limit` bytes of the text as UTF-8, without a broken character at the end. */
export function capText(text: string, limit = BODY_TEXT_LIMIT_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return text;
  return new TextDecoder().decode(bytes.subarray(0, limit)).replace(/�+$/, '');
}

/**
 * The attachments that can be receipts: a PDF or a picture we can read, by its first bytes
 * rather than its label, up to 10 MB, each file once, at most ten.
 */
export function receiptFiles(attachments: readonly Attachment[]): {
  files: EmailFile[];
  skipped: number;
} {
  const files: EmailFile[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const bytes = bytesOf(attachment.content);
    const contentType = sniffMediaType(bytes);
    if (!contentType || bytes.byteLength > RECEIPT_MAX_BYTES) continue;
    if (contentType !== 'application/pdf') {
      const least = attachment.related ? MIN_LAYOUT_PICTURE_BYTES : MIN_PICTURE_BYTES;
      if (bytes.byteLength < least) continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    if (files.length < MAX_RECEIPTS_PER_EMAIL) files.push({ bytes, contentType, sha256 });
  }
  return { files, skipped: attachments.length - files.length };
}

/**
 * Reads the message's parts. A forwarded message's attachments count as its own. The HTML is
 * preferred to the plain part: a receipt's HTML keeps each amount beside its label, while the
 * plain part a sender writes is often just a link to the HTML.
 */
export async function parseEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const sentAt = email.date ? new Date(email.date) : null;
  const text = (email.html ? htmlAsText(email.html) : email.text)?.trim();
  const { files, skipped } = receiptFiles(email.attachments);
  return {
    subject: email.subject?.trim().slice(0, 998) || null,
    sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : null,
    bodyText: text ? capText(text) : null,
    files,
    skipped,
  };
}

/** What keeping an email needs from the provider, the database and storage. */
export interface EmailReadingPorts {
  /** The message exactly as it arrived, or 'gone' once the provider no longer keeps it. */
  fetchRaw(email: ReceivedEmail): Promise<Uint8Array | 'gone'>;
  /** Looks up DKIM keys; the system's DNS when absent. */
  readonly resolver?: DNSResolver;
  memberForSender(address: string): Promise<Sender | undefined>;
  /** The receipt that already holds this file in the organization, if any. */
  filedAs(orgId: string, sha256: string): Promise<string | undefined>;
  saveFile(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  record(
    orgId: string,
    email: NewInboundEmail,
    attachments: readonly InboundAttachment[],
    actorUserId: string,
  ): Promise<RecordInboundEmailResult>;
  now?(): Date;
}

export type KeepEmailResult =
  /** The provider no longer has the message; nothing was kept. */
  | { readonly outcome: 'gone' }
  /** No member signs in with the From address; nothing was kept. */
  | { readonly outcome: 'unknown_sender' }
  | {
      readonly outcome: 'kept';
      readonly status: InboundEmailStatus;
      readonly receiptIds: string[];
      /** Upload events to hand to the receipt workflow. */
      readonly events: CommittedEvent[];
      /** The receipt filed is the email's own text, as a PDF. */
      readonly fromBody?: true;
      readonly problem?: SenderProblem;
    }
  /** Kept on an earlier try; its receipts still waiting are handed on again. */
  | { readonly outcome: 'exists'; readonly events: CommittedEvent[] };

/**
 * Keeps an arriving email for the member who sent it (ADR-0026). The From address must be a
 * member's sign-in address, or nothing is kept. When its signature proves it, each attachment
 * that can be a receipt is stored and filed, and the body text is kept; with nothing attached,
 * the email's text is filed as a PDF instead (ADR-0027). When it doesn't, the email is kept as
 * unverified, with nothing filed and no body, so the member can see it came.
 * Every id is derived from the message, so a retry makes the same records again.
 */
export async function keepEmail(
  ports: EmailReadingPorts,
  received: ReceivedEmail,
): Promise<KeepEmailResult> {
  const raw = await ports.fetchRaw(received);
  if (raw === 'gone') return { outcome: 'gone' };
  const now = ports.now?.() ?? new Date();
  const sender = await checkSender(raw, { resolver: ports.resolver, now });
  const member = sender.address ? await ports.memberForSender(sender.address) : undefined;
  if (!sender.address || !member) return { outcome: 'unknown_sender' };

  const parsed = await parseEmail(raw).catch((error: unknown) => {
    // Retrying can't make a malformed message readable.
    throw new NonRetriableError('The email is not a message we can read', { cause: error });
  });
  const key = `email:${received.provider}:${received.messageId}`;
  // With nothing attached that can be a receipt, the email itself is the receipt: its text,
  // as a PDF, read like an upload (ADR-0027).
  const body =
    sender.verified && parsed.files.length === 0 && parsed.bodyText
      ? await bodyAsFile(parsed.subject, parsed.bodyText)
      : null;
  const files = !sender.verified ? [] : body ? [body] : parsed.files;
  const attachments: InboundAttachment[] = [];
  for (const file of files) {
    const receiptId = derivedId(`${key}:${file.sha256}`);
    const holder = await ports.filedAs(member.orgId, file.sha256);
    // Already a receipt from another upload or email: not filed twice.
    if (holder && holder !== receiptId) continue;
    const storageKey = receiptPath(member.orgId, receiptId);
    if (!holder) await ports.saveFile(storageKey, file.bytes, file.contentType);
    attachments.push({
      receiptId,
      storageKey,
      contentType: file.contentType,
      byteSize: file.bytes.byteLength,
      sha256: file.sha256,
    });
  }
  const status: InboundEmailStatus = !sender.verified
    ? 'unverified'
    : files.length > 0
      ? 'filed'
      : 'no_attachments';
  const result = await ports.record(
    member.orgId,
    {
      id: derivedId(key),
      memberId: member.memberId,
      provider: received.provider,
      providerMessageId: received.messageId,
      fromAddress: sender.address,
      subject: parsed.subject,
      sentAt: parsed.sentAt,
      status,
      bodyText: sender.verified ? parsed.bodyText : null,
    },
    attachments,
    member.userId,
  );
  if (result.status === 'exists') return { outcome: 'exists', events: result.events };
  return {
    outcome: 'kept',
    status,
    receiptIds: result.receiptIds,
    events: result.events,
    ...(body ? { fromBody: true as const } : {}),
    ...(sender.verified ? {} : { problem: sender.problem }),
  };
}

/** The email's text as a PDF file, the receipt an email with nothing attached is filed as. */
export async function bodyAsFile(subject: string | null, text: string): Promise<EmailFile> {
  const bytes = await emailAsPdf(subject, text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, contentType: 'application/pdf', sha256 };
}

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The email an event names, checked before it goes into a provider URL. */
export function receivedEmail(data: unknown): ReceivedEmail {
  const { provider, messageId, threadId } = (data ?? {}) as Record<string, unknown>;
  if (
    provider !== 'bird' ||
    typeof messageId !== 'string' ||
    typeof threadId !== 'string' ||
    !PROVIDER_ID.test(messageId) ||
    !PROVIDER_ID.test(threadId)
  ) {
    throw new NonRetriableError('The event does not name a Bird message and thread');
  }
  return { provider, messageId, threadId };
}

/**
 * Reads an email that arrived at the receipts address: keep it, filing its attachments as
 * receipts, then hand their upload events to the receipt workflow. The relay would deliver
 * them too, but it may not be running (#11), so they are sent here; the runner drops an event
 * id it has already seen. The keeping step is safe to retry as a whole.
 */
export function emailReadingFunction(client: Inngest, ports: () => EmailReadingPorts) {
  return client.createFunction(
    {
      id: 'email-reading',
      name: 'Read an emailed receipt',
      triggers: [{ event: EMAIL_RECEIVED }],
      retries: 3,
    },
    async ({ event, step, logger }) => {
      const received = receivedEmail(event.data);
      const kept = await step.run('keep the email', () => keepEmail(ports(), received));
      const events = 'events' in kept ? kept.events : [];
      if (events.length > 0) {
        await step.sendEvent('read its receipts', events.map(committedWorkflowEvent));
      }
      const { outcome } = kept;
      const summary =
        outcome === 'kept'
          ? {
              outcome,
              status: kept.status,
              receipts: kept.receiptIds.length,
              ...(kept.fromBody ? { fromBody: true } : {}),
              ...(kept.problem ? { problem: kept.problem } : {}),
            }
          : { outcome, receipts: events.length };
      // One line per email, with no address in it, so a missing receipt can be traced.
      logger.info('email-in', { messageId: received.messageId, ...summary });
      return summary;
    },
  );
}
