import { createHmac, timingSafeEqual } from 'node:crypto';

/** The Standard Webhooks headers a signed delivery carries. */
export interface WebhookHeaders {
  readonly id?: string;
  /** Unix seconds, set on each attempt. */
  readonly timestamp?: string;
  /** Space-separated `v1,<base64 HMAC-SHA256>` entries. */
  readonly signature?: string;
}

export type WebhookVerdict = 'valid' | 'missing_headers' | 'stale' | 'bad_signature';

/** Deliveries older or newer than this are refused, so a captured one can't be replayed later. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks a delivery signed the Standard Webhooks way, as Bird signs them: an HMAC-SHA256 of
 * `{id}.{timestamp}.{body}` under the endpoint's secret (`whsec_` and base64). The body must
 * be the exact bytes received, before any parsing.
 */
export function verifyStandardWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  now: Date,
): WebhookVerdict {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return 'missing_headers';
  if (!/^\d{1,12}$/.test(timestamp)) return 'stale';
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return 'stale';
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  const matches = signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? 'valid' : 'bad_signature';
}
