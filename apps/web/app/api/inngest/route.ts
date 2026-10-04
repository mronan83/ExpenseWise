import { createDatabase } from '@expensewise/db';
import {
  amountConversionFunction,
  conversionPorts,
  conversionSweepFunction,
  emailReadingFunction,
  emailReadingPorts,
  outboxRelayFunction,
  receiptReadingFunction,
  receiptReadingPorts,
  relayPorts,
  reportScheduleFunction,
  reportSchedulePorts,
  routeMeasuringFunction,
  routeMeasuringPorts,
  type ConversionPorts,
  type EmailReadingPorts,
  type ReceiptReadingPorts,
  type RelayPorts,
  type ReportSchedulePorts,
  type RouteMeasuringPorts,
} from '@expensewise/workflows';
import { serve } from 'inngest/next';
import {
  appDatabase,
  birdApiKey,
  providerKeyReader,
  receiptFiles,
  routeKeyReader,
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
  const providerKey = providerKeyReader();
  if (!db || !files || !providerKey) {
    throw new Error(
      'Reading receipts needs DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY',
    );
  }
  reading = receiptReadingPorts({ db, files, providerKey });
  return reading;
}

let emails: EmailReadingPorts | undefined;
function emailPorts(): EmailReadingPorts {
  if (emails) return emails;
  const db = appDatabase();
  const files = receiptFiles();
  const apiKey = birdApiKey();
  if (!db || !files || !apiKey) {
    throw new Error(
      'Reading emails needs DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and BIRD_API_KEY',
    );
  }
  emails = emailReadingPorts({ db, files, birdApiKey: apiKey });
  return emails;
}

let schedule: ReportSchedulePorts | undefined;
function schedulePorts(): ReportSchedulePorts {
  if (schedule) return schedule;
  const db = appDatabase();
  if (!db) throw new Error('The report schedule needs DATABASE_URL');
  schedule = reportSchedulePorts(db);
  return schedule;
}

let converting: ConversionPorts | undefined;
function convertingPorts(): ConversionPorts {
  if (converting) return converting;
  const db = appDatabase();
  if (!db) throw new Error('Converting amounts needs DATABASE_URL');
  // Rates come from the ECB's public data API, which needs no key (ADR-0034).
  converting = conversionPorts({ db, overrides: process.env.FLAG_OVERRIDES });
  return converting;
}

let measuring: RouteMeasuringPorts | undefined;
function measuringPorts(): RouteMeasuringPorts {
  if (measuring) return measuring;
  const db = appDatabase();
  const routeKey = routeKeyReader();
  if (!db || !routeKey) {
    throw new Error('Measuring routes needs DATABASE_URL and SUPABASE_SECRET_KEY');
  }
  // Each organization measures with its own OpenRouteService key, kept in Settings (Q31).
  measuring = routeMeasuringPorts({ db, routeKey, flagOverrides: process.env.FLAG_OVERRIDES });
  return measuring;
}

const handler = workflowsServed
  ? serve({
      client: workflowClient,
      functions: [
        ...relayFunctions,
        receiptReadingFunction(workflowClient, readingPorts),
        emailReadingFunction(workflowClient, emailPorts),
        reportScheduleFunction(workflowClient, schedulePorts),
        amountConversionFunction(workflowClient, convertingPorts),
        conversionSweepFunction(workflowClient, convertingPorts),
        routeMeasuringFunction(workflowClient, measuringPorts),
      ],
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

// A reading step calls the model with a 50-second limit; keeping an email fetches it (30
// seconds at most), stores up to ten files and writes them in one transaction.
export const maxDuration = 60;
