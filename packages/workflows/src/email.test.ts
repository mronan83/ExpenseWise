import { generateKeyPairSync } from 'node:crypto';
import type { InboundAttachment, NewInboundEmail, RecordInboundEmailResult } from '@expensewise/db';
import { derivedId } from '@expensewise/domain';
import { receiptPath, RECEIPT_MAX_BYTES, statementPath } from '@expensewise/storage';
import { InngestTestEngine, mockCtx } from '@inngest/test';
import type { DNSResolver } from 'mailauth';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import type { Attachment } from 'postal-mime';
import { describe, expect, it } from 'vitest';
import {
  capText,
  checkSender,
  bodyAsFile,
  emailReadingFunction,
  keepEmail,
  MAX_RECEIPTS_PER_EMAIL,
  parseEmail,
  receiptFiles,
  receivedEmail,
  type EmailReadingPorts,
  type ReceivedEmail,
} from './email.ts';
import { createWorkflowClient, EMAIL_RECEIVED } from './client.ts';
import type { WorkflowEvent } from './relay.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000aa';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000bb';
const USER = 'user-riley';
const NOW = new Date('2026-10-03T18:05:00Z');

// One signing key for every test domain, published through a resolver the tests control.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const resolver: DNSResolver = (name, type) =>
  type === 'TXT' && name.startsWith('s1._domainkey.')
    ? Promise.resolve([[`v=DKIM1; k=rsa; p=${publicDer}`]])
    : Promise.reject(Object.assign(new Error(`no ${type} for ${name}`), { code: 'ENOTFOUND' }));

/** Bytes that sniff as each type, padded to a size. */
const pdf = (size = 30_000, mark = 0) => {
  const bytes = new Uint8Array(size).fill(0x20 + (mark % 90));
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  return bytes;
};
const jpeg = (size: number, mark = 0) => {
  const bytes = new Uint8Array(size).fill(0x30 + (mark % 90));
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};
const png = (size: number) => {
  const bytes = new Uint8Array(size).fill(0x41);
  bytes.set([0x89, 0x50, 0x4e, 0x47]);
  return bytes;
};

interface Part {
  readonly type: string;
  readonly name?: string;
  readonly bytes: Uint8Array;
  readonly inline?: boolean;
  readonly cid?: string;
}

/** A plain multipart message, CRLF throughout, as a mail client would write it. */
function message(options: {
  from?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  parts?: Part[];
}): string {
  const boundary = 'b-1';
  const froms = [options.from ?? 'Riley <riley@example.com>'].flat();
  const lines = [
    ...froms.map((f) => `From: ${f}`),
    'To: receipts@inbox.ai',
    `Subject: ${options.subject ?? 'Fwd: Your receipt'}`,
    'Date: Sat, 03 Oct 2026 18:00:00 +0000',
    'Message-ID: <m1@example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ];
  const body: string[] = [];
  if (options.text !== undefined) {
    body.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', options.text);
  }
  if (options.html !== undefined) {
    body.push(`--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', options.html);
  }
  for (const part of options.parts ?? []) {
    const base64 = Buffer.from(part.bytes).toString('base64').replace(/.{76}/g, '$&\r\n');
    body.push(
      `--${boundary}`,
      `Content-Type: ${part.type}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${part.inline ? 'inline' : 'attachment'}; filename="${part.name ?? 'file'}"`,
      ...(part.cid ? [`Content-ID: <${part.cid}>`] : []),
      '',
      base64,
    );
  }
  body.push(`--${boundary}--`, '');
  return [...lines, ...body].join('\r\n');
}

async function signed(
  raw: string,
  domain = 'example.com',
  extra: { maxBodyLength?: number } = {},
): Promise<string> {
  const signature = { signingDomain: domain, selector: 's1', privateKey: privatePem, ...extra };
  const result = await dkimSign(raw, { ...signature, signTime: NOW, signatureData: [signature] });
  return result.signatures + raw;
}

const bytes = (s: string) => new TextEncoder().encode(s);
const check = (raw: string) => checkSender(bytes(raw), { resolver, now: NOW });

describe('checking who sent an email', () => {
  it('trusts the From address when its own domain signed the message', async () => {
    const raw = await signed(message({ text: 'hi' }));
    expect(await check(raw)).toEqual({
      verified: true,
      address: 'riley@example.com',
      signingDomain: 'example.com',
    });
  });

  it('trusts a signature from another domain of the same organization', async () => {
    const raw = await signed(message({ text: 'hi' }), 'mail.example.com');
    expect(await check(raw)).toMatchObject({ verified: true, address: 'riley@example.com' });
  });

  it('does not trust a signature by some other domain, such as a mailing service', async () => {
    const raw = await signed(message({ text: 'hi' }), 'bulk-mailer.net');
    expect(await check(raw)).toEqual({
      verified: false,
      address: 'riley@example.com',
      problem: 'not_aligned',
    });
  });

  it('does not trust an unsigned message, whatever its From says', async () => {
    expect(await check(message({ text: 'hi' }))).toEqual({
      verified: false,
      address: 'riley@example.com',
      problem: 'unsigned',
    });
  });

  it('does not trust a message changed after it was signed', async () => {
    const raw = await signed(message({ text: 'Total $12.00' }));
    expect(await check(raw.replace('Total $12.00', 'Total $912.00'))).toMatchObject({
      verified: false,
      problem: 'signature_failed',
    });
  });

  it('does not trust a signature that leaves part of the body unsigned', async () => {
    const raw = await signed(message({ text: 'hi' }), 'example.com', { maxBodyLength: 10 });
    expect(await check(raw)).toMatchObject({ verified: false, problem: 'partly_signed' });
  });

  it('asks to be tried again when a key can’t be looked up for now', async () => {
    const raw = await signed(message({ text: 'hi' }));
    const busy: DNSResolver = () =>
      Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    await expect(checkSender(bytes(raw), { resolver: busy, now: NOW })).rejects.toThrow(
      'A DKIM key lookup failed for now',
    );
  });

  it('names no sender when the message has two From fields', async () => {
    const raw = await signed(
      message({ from: ['riley@example.com', 'mallory@example.org'], text: 'hi' }),
    );
    expect(await check(raw)).toEqual({
      verified: false,
      address: null,
      problem: 'no_single_author',
    });
  });

  it('compares addresses in lower case', async () => {
    const raw = await signed(message({ from: 'Riley@Example.COM', text: 'hi' }));
    expect(await check(raw)).toMatchObject({ verified: true, address: 'riley@example.com' });
  });
});

const attachment = (content: Uint8Array, over: Partial<Attachment> = {}): Attachment => ({
  filename: 'file',
  mimeType: 'application/octet-stream',
  disposition: 'attachment',
  content,
  ...over,
});

describe('choosing which attachments are receipts', () => {
  it('takes PDFs and photos by their bytes, whatever they are labelled', () => {
    const { files, skipped } = receiptFiles([
      attachment(pdf(), { mimeType: 'application/octet-stream' }),
      attachment(jpeg(200_000), { mimeType: 'image/png' }),
      attachment(bytes('BEGIN:VCALENDAR'), { mimeType: 'text/calendar' }),
    ]);
    expect(files.map((f) => f.contentType)).toEqual(['application/pdf', 'image/jpeg']);
    expect(files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skipped).toBe(1);
  });

  it('leaves out logos and pictures that lay out the email', () => {
    const { files } = receiptFiles([
      attachment(png(4_000), { disposition: 'inline' }),
      attachment(jpeg(60_000), { disposition: 'inline', related: true }),
      attachment(jpeg(600_000, 1), { disposition: 'inline', related: true }),
      attachment(jpeg(20_000, 2)),
    ]);
    // The big photo pasted into the message, and the attached one, are receipts.
    expect(files.map((f) => f.bytes.byteLength)).toEqual([600_000, 20_000]);
  });

  it('takes each file once, none over 10 MB, and at most ten', () => {
    const many = Array.from({ length: MAX_RECEIPTS_PER_EMAIL + 2 }, (_, i) =>
      attachment(pdf(30_000, i)),
    );
    const { files, skipped } = receiptFiles([
      attachment(pdf(RECEIPT_MAX_BYTES + 1)),
      attachment(pdf(30_000, 0)),
      ...many,
    ]);
    expect(files).toHaveLength(MAX_RECEIPTS_PER_EMAIL);
    expect(new Set(files.map((f) => f.sha256)).size).toBe(MAX_RECEIPTS_PER_EMAIL);
    expect(skipped).toBe(14 - MAX_RECEIPTS_PER_EMAIL);
  });
});

describe('reading an email', () => {
  it('reads its subject, date, text and attachments', async () => {
    const parsed = await parseEmail(
      bytes(message({ text: 'Total $12.00', parts: [{ type: 'application/pdf', bytes: pdf() }] })),
    );
    expect(parsed).toMatchObject({
      subject: 'Fwd: Your receipt',
      sentAt: new Date('2026-10-03T18:00:00Z'),
      bodyText: 'Total $12.00',
      skipped: 0,
    });
    expect(parsed.files.map((f) => f.contentType)).toEqual(['application/pdf']);
  });

  it('keeps an HTML-only email as text', async () => {
    const parsed = await parseEmail(bytes(message({ html: '<p>Total <b>$12.00</b></p>' })));
    expect(parsed.bodyText).toBe('Total $12.00');
  });

  it('prefers the HTML to a plain part that only links to it', async () => {
    const alternative = [
      'From: riley@example.com',
      'Subject: Your receipt',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'View your receipt online.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<table><tr><td>Total</td><td>$12.00</td></tr></table>',
      '--alt--',
      '',
    ].join('\r\n');
    const parsed = await parseEmail(bytes(alternative));
    expect(parsed.bodyText).toMatch(/^Total\s+\$12\.00$/);
  });

  it('keeps at most 64 KiB of text, without breaking a character', () => {
    expect(capText('é'.repeat(10), 5)).toBe('éé');
    expect(capText('short', 64)).toBe('short');
  });
});

const BIRD: ReceivedEmail = { provider: 'bird', messageId: 'rem_01abc', threadId: 'thr_01abc' };

/**
 * Fake provider, database and storage, recording what keeping an email did. `raw` is null once
 * the provider no longer has the message.
 */
function world(
  raw: string | null,
  options: { filed?: Record<string, string>; statements?: boolean } = {},
) {
  const saved: string[] = [];
  const files = new Map<string, Uint8Array>();
  const recorded: { email: NewInboundEmail; attachments: readonly InboundAttachment[] }[] = [];
  const kept = new Set<string>();
  const ports: EmailReadingPorts = {
    fetchRaw: () => Promise.resolve(raw === null ? 'gone' : bytes(raw)),
    resolver,
    now: () => NOW,
    memberForSender: (address) =>
      Promise.resolve(
        address === 'riley@example.com'
          ? { orgId: ORG, memberId: MEMBER, userId: USER }
          : undefined,
      ),
    filedAs: (_org, sha256) => Promise.resolve(options.filed?.[sha256]),
    statementsOn: () => Promise.resolve(options.statements ?? false),
    saveFile: (key, data) => {
      saved.push(key);
      files.set(key, data);
      return Promise.resolve();
    },
    record: (orgId, email, attachments): Promise<RecordInboundEmailResult> => {
      const events = attachments.map((a, i) => ({
        outboxId: `ob-${i}`,
        topic: 'receipt.uploaded',
        orgId,
        payload: { receiptId: a.receiptId },
      }));
      if (kept.has(email.providerMessageId)) return Promise.resolve({ status: 'exists', events });
      kept.add(email.providerMessageId);
      recorded.push({ email, attachments });
      const receiptIds = attachments.map((a) => a.receiptId);
      return Promise.resolve({ status: 'recorded', receiptIds, events });
    },
  };
  return { ports, saved, files, recorded };
}

describe('keeping an email', () => {
  it('files a verified member’s attachments as receipts, under ids made from the message', async () => {
    const file = pdf();
    const raw = await signed(
      message({ text: 'Thanks for riding', parts: [{ type: 'application/pdf', bytes: file }] }),
    );
    const w = world(raw);
    const result = await keepEmail(w.ports, BIRD);

    const [sha] = receiptFiles([attachment(file)]).files.map((f) => f.sha256);
    const receiptId = derivedId(`email:bird:rem_01abc:${sha}`);
    expect(result).toMatchObject({ outcome: 'kept', status: 'filed', receiptIds: [receiptId] });
    expect(w.saved).toEqual([receiptPath(ORG, receiptId)]);
    expect(w.recorded[0]?.email).toMatchObject({
      id: derivedId('email:bird:rem_01abc'),
      memberId: MEMBER,
      provider: 'bird',
      providerMessageId: 'rem_01abc',
      fromAddress: 'riley@example.com',
      status: 'filed',
      bodyText: 'Thanks for riding',
    });
    expect(w.recorded[0]?.attachments).toEqual([
      {
        receiptId,
        storageKey: receiptPath(ORG, receiptId),
        contentType: 'application/pdf',
        byteSize: file.byteLength,
        sha256: sha,
      },
    ]);

    // Tried again, it makes the same records, and hands the events on again.
    const again = await keepEmail(w.ports, BIRD);
    expect(again).toEqual({
      outcome: 'exists',
      events: [expect.objectContaining({ payload: { receiptId } })],
    });
    expect(w.saved).toEqual([receiptPath(ORG, receiptId), receiptPath(ORG, receiptId)]);
  });

  it('files the email itself as a PDF receipt when nothing is attached', async () => {
    const html = '<table><tr><td>Trip fare</td><td>$18.00</td></tr></table>';
    const w = world(await signed(message({ subject: 'Your Uber receipt', html })));
    const result = await keepEmail(w.ports, BIRD);

    const body = await bodyAsFile('Your Uber receipt', 'Trip fare   $18.00');
    const receiptId = derivedId(`email:bird:rem_01abc:${body.sha256}`);
    expect(result).toMatchObject({
      outcome: 'kept',
      status: 'filed',
      receiptIds: [receiptId],
      fromBody: true,
    });
    expect(w.recorded[0]?.attachments).toEqual([
      expect.objectContaining({ receiptId, contentType: 'application/pdf', sha256: body.sha256 }),
    ]);
    const stored = w.files.get(receiptPath(ORG, receiptId));
    expect(new TextDecoder().decode(stored?.subarray(0, 5))).toBe('%PDF-');
    expect(w.recorded[0]?.email.bodyText).toBe('Trip fare   $18.00');
  });

  it('files the attachments, not the text, when something is attached', async () => {
    const raw = await signed(
      message({ text: 'See attached', parts: [{ type: 'application/pdf', bytes: pdf() }] }),
    );
    const result = await keepEmail(world(raw).ports, BIRD);
    expect(result).toMatchObject({ status: 'filed', receiptIds: [expect.any(String)] });
    expect(result).not.toHaveProperty('fromBody');
  });

  it('keeps a verified email with no text and nothing attached, filing nothing', async () => {
    const w = world(await signed(message({ text: '   ' })));
    expect(await keepEmail(w.ports, BIRD)).toMatchObject({
      outcome: 'kept',
      status: 'no_attachments',
      receiptIds: [],
    });
    expect(w.saved).toEqual([]);
  });

  it('files nothing from an email it can’t verify, and keeps no body, only that it came', async () => {
    const raw = message({ text: 'Total $12', parts: [{ type: 'application/pdf', bytes: pdf() }] });
    const w = world(raw);
    expect(await keepEmail(w.ports, BIRD)).toMatchObject({
      outcome: 'kept',
      status: 'unverified',
      receiptIds: [],
      problem: 'unsigned',
    });
    expect(w.saved).toEqual([]);
    expect(w.recorded[0]?.email).toMatchObject({ status: 'unverified', bodyText: null });
    expect(w.recorded[0]?.attachments).toEqual([]);
  });

  it('keeps why it couldn’t prove the sender, such as a message changed after it was signed', async () => {
    const raw = await signed(message({ subject: 'Fwd: Your ride', text: 'Total $12.00' }));
    const w = world(raw.replace('Total $12.00', 'Total $12.00 [scanned]'));
    expect(await keepEmail(w.ports, BIRD)).toMatchObject({
      status: 'unverified',
      problem: 'signature_failed',
    });
    expect(w.recorded[0]?.email).toMatchObject({
      status: 'unverified',
      senderProblem: 'signature_failed',
      subject: 'Fwd: Your ride',
      bodyText: null,
    });

    // A proved sender has no problem to keep, whatever came of the email.
    const proved = world(await signed(message({ text: '   ' })));
    await keepEmail(proved.ports, BIRD);
    expect(proved.recorded[0]?.email).toMatchObject({
      status: 'no_attachments',
      senderProblem: null,
    });
  });

  it('keeps nothing from someone who is not a member', async () => {
    const raw = await signed(
      message({ from: 'stranger@example.com', parts: [{ type: 'application/pdf', bytes: pdf() }] }),
    );
    const w = world(raw);
    expect(await keepEmail(w.ports, BIRD)).toEqual({ outcome: 'unknown_sender' });
    expect(w.saved).toEqual([]);
    expect(w.recorded).toEqual([]);
  });

  it('does not file a file that is already a receipt', async () => {
    const file = pdf();
    const [sha] = receiptFiles([attachment(file)]).files.map((f) => f.sha256);
    const raw = await signed(message({ parts: [{ type: 'application/pdf', bytes: file }] }));
    const w = world(raw, { filed: { [sha!]: 'an-earlier-upload' } });
    expect(await keepEmail(w.ports, BIRD)).toMatchObject({ status: 'filed', receiptIds: [] });
    expect(w.saved).toEqual([]);
  });

  it('keeps nothing once the provider no longer has the message', async () => {
    expect(await keepEmail(world(null).ports, BIRD)).toEqual({ outcome: 'gone' });
  });
});

describe('a card statement forwarded by email (FR-CAP-10, US-CAP-07 AC1)', () => {
  const statementEmail = (subject: string) =>
    signed(
      message({
        subject,
        text: 'See attached',
        parts: [
          { type: 'application/pdf', name: 'statement.pdf', bytes: pdf(40_000, 7) },
          { type: 'image/jpeg', name: 'logo.jpg', bytes: jpeg(20_000) },
        ],
      }),
    );

  it('files its PDF as a statement, not a receipt, where card statements are on', async () => {
    const w = world(await statementEmail('Fwd: Your September statement'), { statements: true });
    expect(await keepEmail(w.ports, BIRD)).toMatchObject({ outcome: 'kept', status: 'filed' });
    const [kept] = w.recorded[0]?.attachments ?? [];
    expect(w.recorded[0]?.attachments).toHaveLength(1);
    expect(kept).toMatchObject({ kind: 'statement', contentType: 'application/pdf' });
    expect(kept?.receiptId).toBe(derivedId(`email:bird:rem_01abc:statement:${kept?.sha256}`));
    expect(w.saved).toEqual([statementPath(ORG, kept!.receiptId)]);
  });

  it('reads it as receipts, as always, where card statements are off (AC9)', async () => {
    const w = world(await statementEmail('Fwd: Your September statement'));
    await keepEmail(w.ports, BIRD);
    expect(w.recorded[0]?.attachments.map((a) => a.kind)).toEqual([undefined, undefined]);
    expect(w.saved.every((key) => key.includes('/receipts/'))).toBe(true);
  });

  // A hotel folio called a statement is filed as one here; the reader then says it isn't one,
  // and how to forward it as a receipt (card-statements.test.ts).
  it('goes by the subject alone: “statement” files statements, anything else receipts', async () => {
    const w = world(await statementEmail('Fwd: Hotel stay, statements of account'), {
      statements: true,
    });
    await keepEmail(w.ports, BIRD);
    expect(w.recorded[0]?.attachments.every((a) => a.kind === 'statement')).toBe(true);

    const receipts = world(await statementEmail('Fwd: Your receipt'), { statements: true });
    await keepEmail(receipts.ports, BIRD);
    expect(receipts.recorded[0]?.attachments.map((a) => a.kind)).toEqual([undefined, undefined]);
  });
});

describe('the email event', () => {
  it('names a Bird message and thread, and nothing that could change the URL', () => {
    expect(receivedEmail({ provider: 'bird', messageId: 'rem_1', threadId: 'thr_1' })).toEqual({
      provider: 'bird',
      messageId: 'rem_1',
      threadId: 'thr_1',
    });
    for (const bad of [
      {},
      { provider: 'bird', messageId: '../x', threadId: 'thr_1' },
      { provider: 'other', messageId: 'rem_1', threadId: 'thr_1' },
    ]) {
      expect(() => receivedEmail(bad)).toThrow('does not name a Bird message');
    }
  });
});

describe('the email reading function', () => {
  const client = createWorkflowClient({ isDev: true });

  it('keeps the email, then hands its receipts to the receipt workflow', async () => {
    const raw = await signed(message({ parts: [{ type: 'application/pdf', bytes: pdf() }] }));
    const w = world(raw);
    const sent: WorkflowEvent[][] = [];
    const t = new InngestTestEngine({
      function: emailReadingFunction(client, () => w.ports),
      events: [{ name: EMAIL_RECEIVED, data: BIRD }],
      transformCtx: (ctx) => {
        const mocked = mockCtx(ctx);
        const sendEvent = ((_id: string, payload: WorkflowEvent[]) => {
          sent.push(payload);
          return Promise.resolve({ ids: [] });
        }) as typeof mocked.step.sendEvent;
        return { ...mocked, step: { ...mocked.step, sendEvent } };
      },
    });
    const { result, error } = await t.execute();
    expect(error).toBeUndefined();
    expect(result).toEqual({ outcome: 'kept', status: 'filed', receipts: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((e) => [e.id, e.name, e.data.orgId, e.data.outboxId])).toEqual([
      ['ob-0', 'receipt.uploaded', ORG, 'ob-0'],
    ]);
  });
});
