import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AuthVariables } from './auth.ts';
import { birdWebhook, type ArrivedEmail } from './bird-webhook.ts';
import { birdWebhookRoute } from './routes/inbound.ts';

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

/**
 * The webhook in the API's contract, answered by the same handler the web app deploys as a
 * function of its own (`birdWebhook`, #93). The web app's API function doesn't configure it,
 * so a delivery that ever reached it would be answered 503 and Bird would deliver it again.
 */
export function registerInboundRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: InboundRouteOptions,
) {
  const answer = birdWebhook({
    secret: options.birdWebhookSecret,
    receiveEmail: options.receiveEmail,
    now: options.now,
  });
  app.openAPIRegistry.registerPath(birdWebhookRoute);
  app.post(birdWebhookRoute.getRoutingPath(), (c) => answer(c.req.raw));
}
