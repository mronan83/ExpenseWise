import { Inngest } from 'inngest';

/*
 * What a server needs to send events to the workflow runner, and nothing of the workflows
 * themselves, so a small function such as Bird's webhook (#93) can send one without loading them.
 */

/** Sent by the inbound webhook for each email that arrives (ADR-0026). */
export const EMAIL_RECEIVED = 'email/received';

export interface WorkflowClientConfig {
  /** Sends events to Inngest. Production needs it; the Vercel integration sets it. */
  readonly eventKey?: string;
  /** Verifies that calls to /api/inngest come from Inngest. */
  readonly signingKey?: string;
  /** Talks to a local Inngest dev server instead of Inngest Cloud. */
  readonly isDev?: boolean;
  /** Deployed commit SHA. */
  readonly appVersion?: string;
}

export function createWorkflowClient(config: WorkflowClientConfig = {}): Inngest {
  return new Inngest({ id: 'expensewise', ...config });
}
