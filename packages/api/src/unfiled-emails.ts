import {
  dismissInboundEmail,
  type Database,
  type DismissEmailResult,
  type UnfiledEmailRecord,
} from '@expensewise/db';
import { unfiledEmailsSince } from '@expensewise/domain';
import { asCaller } from './caller.ts';
import type { FeatureGate } from './features.ts';

/** The flag emails that filed nothing ship behind (Q5, #59). */
export const UNFILED_EMAILS_FLAG = 'receipts.unfiled-emails';

/**
 * Dismissing an email that filed nothing from Needs you (#59). Needs you reads the emails with
 * the rest of what needs the person, in one transaction. Tests use an in-memory fake.
 */
export interface UnfiledEmailStore {
  dismiss(orgId: string, emailId: string, actorUserId: string): Promise<DismissEmailResult>;
}

/**
 * The store on Postgres, as expensewise_app, for the request's caller: an email is its
 * member's own, so only they dismiss it (ADR-0035).
 */
export function dbUnfiledEmailStore(db: Database): UnfiledEmailStore {
  const inOrg = asCaller(db);
  return {
    dismiss: (orgId, emailId, actor) =>
      inOrg(orgId, (tx) => dismissInboundEmail(tx, orgId, emailId, actor)),
  };
}

/**
 * Since when Needs you lists the person's emails that filed nothing: where they can be shown
 * and the organization has them on. Undefined otherwise, and Needs you reads nothing more.
 */
export async function unfiledEmailsAsked(
  options: { readonly emails?: UnfiledEmailStore },
  features: FeatureGate,
  orgId: string,
  now: Date,
): Promise<Date | undefined> {
  if (!options.emails || !(await features.isOn(orgId, UNFILED_EMAILS_FLAG))) return undefined;
  return unfiledEmailsSince(now);
}

/**
 * An email that filed nothing, as Needs you shows it: who it was from and its subject, which
 * are the member's own, and why it filed nothing, but never its text.
 */
export function unfiledEmailItem(email: UnfiledEmailRecord) {
  return {
    kind: 'email' as const,
    email: {
      id: email.id,
      subject: email.subject,
      from: email.fromAddress,
      receivedAt: email.receivedAt.toISOString(),
    },
    reason:
      email.status === 'unverified'
        ? { code: 'unproved' as const, problem: email.senderProblem }
        : { code: 'empty' as const, problem: null },
  };
}
