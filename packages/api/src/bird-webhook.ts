import { problemDocument, type ProblemExtra } from './problem.ts';
import { verifyStandardWebhook } from './webhooks.ts';

/*
 * Bird's webhook (ADR-0026) as a plain fetch handler that needs nothing else of the API, so the
 * web app serves it from a function of its own: a cold start loads this and the hand-off, never
 * the whole API, and stays well inside the time Bird waits for an answer however large the API
 * grows (#93). Keep its imports to the signature check and the problem document.
 */

/** An email the provider holds, named the way its API finds it again. */
export interface ArrivedEmail {
  readonly provider: 'bird';
  readonly messageId: string;
  readonly threadId: string;
}

export interface BirdWebhookOptions {
  /** Bird's signing secret for the webhook (`whsec_…`). Without it, the webhook answers 503. */
  readonly secret?: string;
  /**
   * Hands an arriving email to the workflow that reads it. It must not lose the email: when
   * it throws, the webhook answers 503 and Bird delivers it again.
   */
  readonly receiveEmail?: (email: ArrivedEmail) => Promise<void>;
  readonly now?: () => Date;
}

/** The one event email-in reads; every other is acknowledged and ignored. */
export const BIRD_MESSAGE_RECEIVED = 'email_mailbox.message_received';
/** The ids read from an arriving message. They go into Bird's URL, so nothing else passes. */
export const BIRD_MESSAGE_ID = /^rem_[0-9a-z]{1,64}$/;
export const BIRD_THREAD_ID = /^thr_[0-9a-z]{1,64}$/;

const answer = (status: number, body: unknown, contentType = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });

const refuse = (status: number, slug: string, title: string, extra: ProblemExtra) =>
  answer(status, problemDocument(status, slug, title, extra), 'application/problem+json');

const rejected = (detail: string) => {
  console.warn('email-in: refused a Bird event', { detail });
  return refuse(400, 'invalid-request', 'The event is not one Bird sends', {
    detail,
    code: 'invalid_request',
  });
};

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

/**
 * Answers one delivery. The signature covers the exact bytes, so it is checked before anything
 * parses the body, which is then read as JSON whatever content type it is labelled with. Bird
 * retries anything that isn't 2xx, so a signed event email-in doesn't read is acknowledged
 * whatever else it carries; only an arriving mailbox message has its ids checked, and is
 * answered 503 while nothing can take it on, so Bird delivers it again.
 */
export function birdWebhook(options: BirdWebhookOptions): (request: Request) => Promise<Response> {
  const notConfigured = () =>
    refuse(503, 'email-in-not-configured', 'Email-in is not configured', {
      code: 'email_in_not_configured',
    });
  return async (request) => {
    const { secret, receiveEmail } = options;
    if (!secret) return notConfigured();
    const body = await request.text();
    const verdict = verifyStandardWebhook(
      secret,
      {
        id: request.headers.get('webhook-id') ?? undefined,
        timestamp: request.headers.get('webhook-timestamp') ?? undefined,
        signature: request.headers.get('webhook-signature') ?? undefined,
      },
      body,
      options.now?.() ?? new Date(),
    );
    if (verdict !== 'valid') {
      return refuse(401, 'invalid-signature', 'The webhook signature is not valid', {
        code: verdict,
      });
    }

    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return rejected('The body is not JSON');
    }
    const type = Array.isArray(event) ? undefined : field(event, 'type');
    if (typeof type !== 'string') return rejected('The body is not a Bird event');
    if (type !== BIRD_MESSAGE_RECEIVED) {
      console.info('email-in: ignored a Bird event', { type });
      return answer(200, { status: 'ignored' });
    }

    const data = field(event, 'data');
    const messageId = field(data, 'message_id');
    const threadId = field(data, 'thread_id');
    if (!matches(messageId, BIRD_MESSAGE_ID) || !matches(threadId, BIRD_THREAD_ID)) {
      const unusable = [
        matches(messageId, BIRD_MESSAGE_ID) ? null : 'message_id',
        matches(threadId, BIRD_THREAD_ID) ? null : 'thread_id',
      ].filter(Boolean);
      return rejected(`Unusable ${unusable.join(' and ')} on ${BIRD_MESSAGE_RECEIVED}`);
    }
    if (!receiveEmail) return notConfigured();
    try {
      await receiveEmail({ provider: 'bird', messageId, threadId });
      console.info('email-in: accepted', { messageId });
    } catch (error) {
      console.error('Handing an arriving email to the workflow runner failed', error);
      return refuse(503, 'hand-off-failed', 'The email could not be handed on yet', {
        code: 'hand_off_failed',
      });
    }
    return answer(202, { status: 'accepted' });
  };
}
