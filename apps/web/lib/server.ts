import { createSecretBox, storedKeyReader } from '@expensewise/api';
import { createDatabase, type Database } from '@expensewise/db';
import { SUPPORTED_MEDIA_TYPES } from '@expensewise/extraction';
import {
  RECEIPT_BUCKET,
  RECEIPT_MAX_BYTES,
  supabaseStorage,
  type ObjectStore,
} from '@expensewise/storage';
import { createWorkflowClient, toWorkflowEvent } from '@expensewise/workflows';
import type { CommittedEvent } from '@expensewise/db';

/*
 * Server-side dependencies shared by the API route and the workflow route. Each is built on
 * first use and is undefined when its settings are missing, so the app still starts and the
 * routes that need it answer 503 instead.
 */

const env = (name: string) => process.env[name] || undefined;

/** Logs instead of throwing: a bad setting disables what needs it, not the whole app. */
function optional<T>(name: string, build: () => T): T | undefined {
  try {
    return build();
  } catch (error) {
    console.error(`${name} is not usable; what needs it will answer 503`, error);
    return undefined;
  }
}

let database: Database | null | undefined;
/** Tenant data as expensewise_app. Two connections per instance suit the pooler. */
export function appDatabase(): Database | undefined {
  if (database === undefined) {
    const url = env('DATABASE_URL');
    database = (url && optional('DATABASE_URL', () => createDatabase(url, { max: 2 }).db)) || null;
  }
  return database ?? undefined;
}

// AI provider keys are encrypted with a key derived from this server-only secret (ADR-0015).
const encryptionSecret = () => env('APP_ENCRYPTION_KEY') ?? env('SUPABASE_SECRET_KEY');

export const secretBox = () => {
  const secret = encryptionSecret();
  return secret ? optional('The key encryption secret', () => createSecretBox(secret)) : undefined;
};

let files: ObjectStore | null | undefined;
/** The private receipts bucket, through the server-side secret key (ADR-0013). */
export function receiptFiles(): ObjectStore | undefined {
  if (files === undefined) {
    const projectUrl = env('NEXT_PUBLIC_SUPABASE_URL');
    const secretKey = env('SUPABASE_SECRET_KEY');
    files =
      projectUrl && secretKey
        ? supabaseStorage({
            projectUrl,
            secretKey,
            bucket: RECEIPT_BUCKET,
            fileSizeLimitBytes: RECEIPT_MAX_BYTES,
            allowedMimeTypes: SUPPORTED_MEDIA_TYPES,
          })
        : null;
  }
  return files ?? undefined;
}

export const workflowsDev = env('INNGEST_DEV') === '1';
const eventKey = env('INNGEST_EVENT_KEY');
const signingKey = env('INNGEST_SIGNING_KEY');

/** Whether Inngest can call /api/inngest: dev mode, or both keys from the integration. */
export const workflowsServed = workflowsDev || Boolean(eventKey && signingKey);

export const workflowClient = createWorkflowClient({
  eventKey,
  signingKey,
  isDev: workflowsDev,
  appVersion: env('VERCEL_GIT_COMMIT_SHA')?.slice(0, 7),
});

/**
 * Sends committed outbox events to Inngest right after the commit, with the outbox id as the
 * event id, so the relay's later copy is dropped as a duplicate (ADR-0017). Undefined when
 * this server can't send events.
 */
export const dispatchEvents =
  workflowsDev || eventKey
    ? async (events: readonly CommittedEvent[]) => {
        await workflowClient.send(
          events.map((e) =>
            toWorkflowEvent({
              id: e.outboxId,
              orgId: e.orgId,
              topic: e.topic,
              payload: { ...e.payload },
              createdAt: new Date().toISOString(),
              attempts: 0,
            }),
          ),
        );
      }
    : undefined;

/** Decrypts an organization's stored Anthropic key for the receipt workflow. */
export function anthropicKeyReader() {
  const db = appDatabase();
  const secrets = secretBox();
  if (!db || !secrets) return undefined;
  const read = storedKeyReader(db, secrets);
  return (orgId: string) => read(orgId, 'anthropic');
}
