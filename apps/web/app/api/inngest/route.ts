import { createDatabase } from '@expensewise/db';
import {
  createWorkflowClient,
  outboxRelayFunction,
  relayPorts,
  type RelayPorts,
} from '@expensewise/workflows';
import { serve } from 'inngest/next';

// Inngest calls this route to run our workflows (ADR-0003). Static segments win over the
// /api catch-all, so the versioned API never sees these requests.
const isDev = process.env.INNGEST_DEV === '1';
const eventKey = process.env.INNGEST_EVENT_KEY;
const signingKey = process.env.INNGEST_SIGNING_KEY;

const client = createWorkflowClient({
  eventKey,
  signingKey,
  isDev,
  appVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
});

// The relay connects as expensewise_relay, which can only claim and mark outbox events.
let ports: RelayPorts | undefined;
function relay(): RelayPorts {
  const url = process.env.RELAY_DATABASE_URL;
  if (!url) throw new Error('RELAY_DATABASE_URL is not set');
  ports ??= relayPorts(createDatabase(url, { max: 1 }).db, client);
  return ports;
}

const handler =
  isDev || (eventKey && signingKey)
    ? serve({ client, functions: [outboxRelayFunction(client, relay)] })
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

// A relay run can take several database and network round trips.
export const maxDuration = 60;
