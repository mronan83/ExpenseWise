import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AuthVariables } from './auth.ts';
import { ProblemError } from './problem.ts';
import { birdWebhookRoute } from './routes/inbound.ts';
import { BirdMessageReceivedSchema, BirdWebhookSchema } from './schemas.ts';
import { verifyStandardWebhook } from './webhooks.ts';

/** An email the provider holds, named the way its API finds it again. */
export interface ArrivedEmail {
  readonly provider: 'bird';
  readonly messageId: string;
  readonly threadId: string;
}

export interface InboundRouteOptions {
  /** Bird's signing secret for the webhook (`whsec_…`). Without it, the webhook answers 503. */
  readonly birdWebhookSecret?: string;
  /**
   * Hands an arriving email to the workflow that reads it. It must not lose the email: when
   * it throws, the webhook answers 503 and Bird delivers it again.
   */
  readonly receiveEmail?: (email: ArrivedEmail) => Promise<void>;
  readonly now?: () => Date;
}

const RECEIVED = 'email_mailbox.message_received';

export function registerInboundRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: InboundRouteOptions,
) {
  const notConfigured = () =>
    new ProblemError(503, 'email-in-not-configured', 'Email-in is not configured', {
      code: 'email_in_not_configured',
    });

  // The signature covers the exact bytes, so it is checked before anything parses the body.
  app.use(birdWebhookRoute.getRoutingPath(), async (c, next) => {
    const secret = options.birdWebhookSecret;
    if (!secret || !options.receiveEmail) throw notConfigured();
    const verdict = verifyStandardWebhook(
      secret,
      {
        id: c.req.header('webhook-id'),
        timestamp: c.req.header('webhook-timestamp'),
        signature: c.req.header('webhook-signature'),
      },
      await c.req.text(),
      options.now?.() ?? new Date(),
    );
    if (verdict !== 'valid') {
      throw new ProblemError(401, 'invalid-signature', 'The webhook signature is not valid', {
        code: verdict,
      });
    }
    await next();
  });

  const rejected = (detail: string) => {
    console.warn('email-in: refused a Bird event', { detail });
    return new ProblemError(400, 'invalid-request', 'The event is not one Bird sends', {
      detail,
      code: 'invalid_request',
    });
  };

  // Read from the verified bytes as JSON, whatever content type the delivery is labelled with.
  // Only an arriving mailbox message is checked further; Bird retries anything not 2xx, so any
  // other event is acknowledged rather than refused.
  app.openAPIRegistry.registerPath(birdWebhookRoute);
  app.post(birdWebhookRoute.getRoutingPath(), async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      throw rejected('The body is not JSON');
    }
    const envelope = BirdWebhookSchema.safeParse(body);
    if (!envelope.success) throw rejected('The body is not a Bird event');
    const { type, data } = envelope.data;
    if (type !== RECEIVED) {
      console.info('email-in: ignored a Bird event', { type });
      return c.json({ status: 'ignored' as const }, 200);
    }
    const ids = BirdMessageReceivedSchema.safeParse(data);
    if (!ids.success) {
      throw rejected(
        `Unusable ${ids.error.issues.map((i) => i.path.join('.')).join(' and ')} on ${RECEIVED}`,
      );
    }
    const receive = options.receiveEmail;
    if (!receive) throw notConfigured();
    const { message_id: messageId, thread_id: threadId } = ids.data;
    try {
      await receive({ provider: 'bird', messageId, threadId });
      console.info('email-in: accepted', { messageId });
    } catch (error) {
      console.error('Handing an arriving email to the workflow runner failed', error);
      throw new ProblemError(503, 'hand-off-failed', 'The email could not be handed on yet', {
        code: 'hand_off_failed',
      });
    }
    return c.json({ status: 'accepted' as const }, 202);
  });
}
