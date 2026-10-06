import type { ArrivedEmail } from '@expensewise/api/bird-webhook';
import { createWorkflowClient, EMAIL_RECEIVED } from '@expensewise/workflows/client';

/*
 * Email-in's hand-off, for Bird's webhook, which runs as a function of its own (#93). It needs
 * only the workflow client, so it never imports ./server, which builds the database, storage
 * and the workflows themselves.
 */

const env = (name: string) => process.env[name] || undefined;
const isDev = env('INNGEST_DEV') === '1';
const eventKey = env('INNGEST_EVENT_KEY');

/**
 * Hands an arriving email to the email workflow (ADR-0026). The event id is the provider's
 * message id, so a second delivery of the same message within a day starts nothing; after
 * that, the workflow finds the email already kept. Undefined when this server can't send
 * events, and then the webhook answers 503 and Bird tries again later.
 */
export const handOffEmail = (() => {
  if (!isDev && !eventKey) return undefined;
  const client = createWorkflowClient({
    eventKey,
    isDev,
    appVersion: env('VERCEL_GIT_COMMIT_SHA')?.slice(0, 7),
  });
  return async (email: ArrivedEmail) => {
    await client.send({
      id: `${email.provider}-${email.messageId}`,
      name: EMAIL_RECEIVED,
      data: email,
    });
  };
})();
