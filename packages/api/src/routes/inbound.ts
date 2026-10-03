import { createRoute, z } from '@hono/zod-openapi';
import { BirdWebhookSchema, ProblemSchema, WebhookReceiptSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

export const birdWebhookRoute = createRoute({
  method: 'post',
  path: '/v1/inbound/bird',
  tags: ['Email-in'],
  summary: 'Bird calls this when an email arrives at the receipts address',
  description:
    'Signed by Bird with the Standard Webhooks scheme; the signature, not a sign-in, is what ' +
    'lets it in, and a delivery more than 5 minutes off is refused. An arriving email is ' +
    'handed to a background workflow, which fetches it, checks its sender and files its ' +
    'attachments as receipts (FR-CAP-02, ADR-0026). Other events are acknowledged and ignored.',
  request: {
    headers: z.object({
      'webhook-id': z.string().openapi({ description: 'The same on every retry.' }),
      'webhook-timestamp': z.string().openapi({ description: 'Unix seconds, per attempt.' }),
      'webhook-signature': z.string().openapi({ description: 'v1,<base64 HMAC-SHA256>' }),
    }),
    body: { required: true, content: { 'application/json': { schema: BirdWebhookSchema } } },
  },
  responses: {
    200: {
      description: 'An event email-in does not use; nothing was done.',
      content: { 'application/json': { schema: WebhookReceiptSchema } },
    },
    202: {
      description: 'The email will be read in the background.',
      content: { 'application/json': { schema: WebhookReceiptSchema } },
    },
    400: problem('The event is not one Bird would send.'),
    401: problem('The signature is missing, wrong or too old.'),
    503: problem('Email-in is not configured here, or the hand-off failed; Bird tries again.'),
  },
});
