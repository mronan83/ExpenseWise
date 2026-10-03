import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AuthVariables } from './auth.ts';
import { ProblemError } from './problem.ts';
import { birdWebhookRoute } from './routes/inbound.ts';
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

  app.openapi(birdWebhookRoute, async (c) => {
    const { type, data } = c.req.valid('json');
    if (type !== RECEIVED || !data.message_id || !data.thread_id) {
      return c.json({ status: 'ignored' as const }, 200);
    }
    const receive = options.receiveEmail;
    if (!receive) throw notConfigured();
    try {
      await receive({ provider: 'bird', messageId: data.message_id, threadId: data.thread_id });
    } catch (error) {
      console.error('Handing an arriving email to the workflow runner failed', error);
      throw new ProblemError(503, 'hand-off-failed', 'The email could not be handed on yet', {
        code: 'hand_off_failed',
      });
    }
    return c.json({ status: 'accepted' as const }, 202);
  });
}
