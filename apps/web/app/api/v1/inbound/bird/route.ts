import { birdWebhook } from '@expensewise/api/bird-webhook';
import { handOffEmail } from '../../../../../lib/email-in';

/*
 * Bird's webhook as a function of its own (#93, ADR-0026). Next.js routes this path here, not
 * to the API's catch-all, so a cold start loads only the signature check and the hand-off and
 * Bird has its answer well inside the time it waits, however large the API grows. Import
 * nothing else here: e2e/bird-webhook checks this function is the one that answers.
 */

// A setting of its own: Vercel bundles routes whose settings differ separately, so this one
// never shares the API's bundle. It hands off in well under a second.
export const maxDuration = 10;

export const POST = birdWebhook({
  secret: process.env.BIRD_WEBHOOK_SECRET || undefined,
  receiveEmail: handOffEmail,
});
