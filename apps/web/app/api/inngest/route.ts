import { createDatabase } from '@expensewise/db';
import {
  outboxRelayFunction,
  receiptReadingFunction,
  receiptReadingPorts,
  relayPorts,
  type ReceiptReadingPorts,
  type RelayPorts,
} from '@expensewise/workflows';
import { serve } from 'inngest/next';
import {
  anthropicKeyReader,
  appDatabase,
  receiptFiles,
  workflowClient,
  workflowsServed,
} from '../../../lib/server';

// Inngest calls this route to run our workflows (ADR-0003). Static segments win over the
// /api catch-all, so the versioned API never sees these requests.

// The relay connects as expensewise_relay, which can only claim and mark outbox events. It
// is registered only with its URL: a sweep that fails every 5 minutes, with retries, would
// spend most of the free plan's executions on errors.
const relayUrl = process.env.RELAY_DATABASE_URL;
let relay: RelayPorts | undefined;
const relayFunctions = relayUrl
  ? [
      outboxRelayFunction(workflowClient, () => {
        relay ??= relayPorts(createDatabase(relayUrl, { max: 1 }).db, workflowClient);
        return relay;
      }),
    ]
  : [];

let reading: ReceiptReadingPorts | undefined;
function readingPorts(): ReceiptReadingPorts {
  if (reading) return reading;
  const db = appDatabase();
  const files = receiptFiles();
  const anthropicKey = anthropicKeyReader();
  if (!db || !files || !anthropicKey) {
    throw new Error(
      'Reading receipts needs DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY',
    );
  }
  reading = receiptReadingPorts({ db, files, anthropicKey });
  return reading;
}

const handler = workflowsServed
  ? serve({
      client: workflowClient,
      functions: [...relayFunctions, receiptReadingFunction(workflowClient, readingPorts)],
    })
  : undefined;

// Without keys the route says so plainly, rather than failing the build or every request.
const notConfigured = () =>
  Response.json(
    {
      type: 'https://expensewise.dev/problems/workflows-not-configured',
      title: 'Workflows are not configured',
      status: 503,
      code: 'workflows_not_configured',
    },
    { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
  );

export const GET = handler?.GET ?? notConfigured;
export const POST = handler?.POST ?? notConfigured;
export const PUT = handler?.PUT ?? notConfigured;

// A reading step calls the model with a 50-second limit.
export const maxDuration = 60;
