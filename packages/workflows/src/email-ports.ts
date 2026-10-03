import {
  findReceiptBySha256,
  memberForSender,
  recordInboundEmail,
  type Database,
} from '@expensewise/db';
import type { ObjectStore } from '@expensewise/storage';
import { NonRetriableError } from 'inngest';
import type { EmailReadingPorts, ReceivedEmail } from './email.ts';
import { checkedDatabase } from './receipt-ports.ts';

/** Bird's API host for a key: `bk_us1_…` keys go to us1, `bk_eu1_…` keys to eu1. */
export function birdApiBase(apiKey: string): string {
  const region = /^bk_([a-z]{2}\d)_/.exec(apiKey)?.[1] ?? 'us1';
  return `https://${region}.platform.bird.com`;
}

/**
 * Fetches a mailbox message exactly as it arrived (RFC 5322), which Bird keeps for 30 days.
 * Its DKIM signatures can only be checked on these bytes. One attempt with a 30-second limit;
 * the workflow runner retries the step instead.
 */
export function birdRawMessage(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async (email: ReceivedEmail): Promise<Uint8Array | 'gone'> => {
    const thread = encodeURIComponent(email.threadId);
    const message = encodeURIComponent(email.messageId);
    const response = await fetchImpl(
      `${birdApiBase(apiKey)}/v1/email/threads/${thread}/messages/${message}/raw`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'message/rfc822' },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    // Past 30 days Bird has only the parsed message; there is nothing left to check.
    if (response.status === 410) return 'gone';
    const detail = `Bird answered ${response.status} for message ${email.messageId}`;
    if (response.status === 401 || response.status === 403) {
      throw new NonRetriableError(`${detail}: BIRD_API_KEY needs the mailbox:read scope`);
    }
    // A 404 may only mean the message isn't ready yet, so it is tried again.
    const retry = [404, 408, 429].includes(response.status) || response.status >= 500;
    throw retry ? new Error(detail) : new NonRetriableError(detail);
  };
}

export interface EmailReadingDeps {
  /** As expensewise_app. Only the sender lookup runs outside an organization. */
  readonly db: Database;
  readonly files: ObjectStore;
  /** A Bird API key with the mailbox:read scope. */
  readonly birdApiKey: string;
  readonly fetch?: typeof fetch;
}

/** The email workflow on Bird, Postgres and Supabase Storage (ADR-0026). */
export function emailReadingPorts(deps: EmailReadingDeps): EmailReadingPorts {
  const { safe, inOrg } = checkedDatabase(deps.db);
  return {
    fetchRaw: birdRawMessage(deps.birdApiKey, deps.fetch),
    async memberForSender(address) {
      await safe();
      return memberForSender(deps.db, address);
    },
    filedAs: (orgId, sha256) =>
      inOrg(orgId, async (tx) => (await findReceiptBySha256(tx, sha256))?.id),
    saveFile: (storageKey, bytes, contentType) => deps.files.save(storageKey, bytes, contentType),
    record: (orgId, email, attachments, actorUserId) =>
      inOrg(orgId, (tx) => recordInboundEmail(tx, orgId, email, attachments, actorUserId)),
  };
}
