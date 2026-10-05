import { LET_IN_HOURS } from '@expensewise/domain';
import { and, eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import { withOrg, type Database, type Transaction } from './client.ts';
import type { Membership } from './members.ts';
import { letInSignIns, members } from './schema.ts';
import { letInCounts, listSignIns, type SignIn } from './sign-ins.ts';

/*
 * Which of a person's emails are let in (#90, Q44, ADR-0044). While their organization has the
 * second factor on and they have an authenticator, only an email let in opens the app, and only
 * the one they first signed in with is let in on its own (#91, Q45). The API decides when
 * (`admission` in @expensewise/domain); these keep the record, each change with its audit event,
 * and the trigger `enforce_let_in` holds every change to the person themselves, from a session of
 * an email with an authenticator of its own that passed the code.
 */

/** Who is changing who is let in: the token's sign-in, and whether its session passed the code. */
export interface LetInActor {
  readonly userId: string;
  readonly assuranceLevel: string;
}

/**
 * Runs `work` in the member's organization as `actor`, whom the database knows by their sign-in
 * and their session's level for this transaction only, after locking the person's emails so
 * two changes to them never cross.
 */
function asActor<T>(
  db: Database,
  member: Membership,
  actor: LetInActor,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withOrg(
    db,
    member.orgId,
    async (tx) => {
      await tx.execute(
        sql`select set_config('app.assurance_level', ${actor.assuranceLevel}, true)`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`let_in:${member.memberId}`}, 0))`,
      );
      return work(tx);
    },
    { userId: actor.userId },
  );
}

/** The member's sign-ins, the actor's own and the one asked about, as listed. */
async function emailsOf(tx: Transaction, member: Membership, actor: LetInActor) {
  const all = await listSignIns(tx, member.memberId);
  return { all, own: all.find((s) => s.userId === actor.userId) };
}

/** A lapsed let-in of a sign-in counts for nothing; it goes before the sign-in is let in again. */
async function clearLapsed(tx: Transaction, signInId: string): Promise<void> {
  await tx
    .delete(letInSignIns)
    .where(and(eq(letInSignIns.signInId, signInId), sql`not ${letInCounts}`));
}

const audit = (
  tx: Transaction,
  member: Membership,
  actor: LetInActor,
  signInId: string,
  action: string,
  payload: Record<string, unknown> = {},
) =>
  appendAuditEvent(tx, member.orgId, {
    actor: { type: 'user', id: actor.userId },
    entityType: 'member_sign_in',
    entityId: signInId,
    action,
    payload: { memberId: member.memberId, ...payload },
  });

/** What passing the code did for the email it was passed on. */
export type PassedCode =
  /** None of the person's emails was let in: it is now, the first. */
  | 'let_in_first'
  /** It was let in and waiting: it stays let in. */
  | 'passed'
  /** It was let in already. */
  | 'let_in'
  /**
   * It isn't let in: another of the person's emails is and this one isn't, or none is and this
   * isn't the one they first signed in with (#91). Nothing changes.
   */
  | 'not_let_in';

/** Whether the sign-in is the one the member was made with: the email first signed in with. */
async function isFirstSignIn(tx: Transaction, member: Membership, userId: string) {
  const [made] = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(eq(members.id, member.memberId));
  return made?.userId === userId;
}

/**
 * Records that the actor's email passed its code, from a session that did, as the API sees it on
 * a request (#90): the email the person first signed in with, while none of theirs is let in, is
 * let in then, the first (#91); one let in and waiting stays let in. Each is audited. Any other
 * email is let in only from one let in. Checked again under the lock, so a change to the
 * person's emails in between is seen.
 */
export async function recordPassedCode(
  db: Database,
  member: Membership,
  actor: LetInActor,
): Promise<PassedCode> {
  return asActor(db, member, actor, async (tx) => {
    const { all, own } = await emailsOf(tx, member, actor);
    if (!own) return 'not_let_in';
    if (own.letIn === 'yes') return 'let_in';
    if (own.letIn === 'waiting') {
      await tx
        .update(letInSignIns)
        .set({ passedAt: sql`now()`, lapsesAt: null })
        .where(eq(letInSignIns.signInId, own.id));
      await audit(tx, member, actor, own.id, 'member_sign_in.let_in_confirmed');
      return 'passed';
    }
    if (all.some((s) => s.letIn !== 'no')) return 'not_let_in';
    if (!(await isFirstSignIn(tx, member, own.userId))) return 'not_let_in';
    await clearLapsed(tx, own.id);
    await tx
      .insert(letInSignIns)
      .values({ orgId: member.orgId, signInId: own.id, passedAt: sql`now()` });
    await audit(tx, member, actor, own.id, 'member_sign_in.let_in', { first: true });
    return 'let_in_first';
  });
}

export type LetInResult =
  | { readonly status: 'let_in' | 'already_let_in'; readonly signIn: SignIn }
  /** The member has no such sign-in. */
  | { readonly status: 'not_found' }
  /** It is the actor's own: an email never lets itself in, or withdraws itself. */
  | { readonly status: 'current' }
  /** The actor's own email isn't let in, past its code, so it lets no one in. */
  | { readonly status: 'actor_not_let_in' };

/**
 * Lets another of the member's emails in, from the actor's, which must be let in, with an
 * authenticator of its own, past its code (#90). It waits until it passes its own code, which it
 * may do once it adds an authenticator, for `LET_IN_HOURS`; then letting it in lapses. Audited.
 */
export async function letSignInIn(
  db: Database,
  member: Membership,
  signInId: string,
  actor: LetInActor,
): Promise<LetInResult> {
  return asActor(db, member, actor, async (tx) => {
    const { all, own } = await emailsOf(tx, member, actor);
    const target = all.find((s) => s.id === signInId);
    if (!target) return { status: 'not_found' };
    if (target.id === own?.id) return { status: 'current' };
    if (own?.letIn !== 'yes') return { status: 'actor_not_let_in' };
    if (target.letIn !== 'no') return { status: 'already_let_in', signIn: target };
    await clearLapsed(tx, target.id);
    const [row] = await tx
      .insert(letInSignIns)
      .values({
        orgId: member.orgId,
        signInId: target.id,
        lapsesAt: sql`now() + make_interval(hours => ${LET_IN_HOURS})`,
      })
      .returning({ lapsesAt: letInSignIns.lapsesAt });
    await audit(tx, member, actor, target.id, 'member_sign_in.let_in', {
      first: false,
      lapsesAt: row?.lapsesAt?.toISOString() ?? null,
    });
    return {
      status: 'let_in',
      signIn: { ...target, letIn: 'waiting', letInLapsesAt: row?.lapsesAt ?? null },
    };
  });
}

export type WithdrawResult =
  | 'withdrawn'
  /** It isn't let in, or letting it in lapsed: nothing to withdraw. */
  | 'not_let_in'
  | 'not_found'
  | 'current'
  | 'actor_not_let_in';

/**
 * Withdraws letting one of the member's other emails in, from the actor's, which must be let
 * in, with an authenticator of its own, past its code (#90): it is refused again, as if never
 * let in, and still forwards receipts. Audited.
 */
export async function withdrawSignIn(
  db: Database,
  member: Membership,
  signInId: string,
  actor: LetInActor,
): Promise<WithdrawResult> {
  return asActor(db, member, actor, async (tx) => {
    const { all, own } = await emailsOf(tx, member, actor);
    const target = all.find((s) => s.id === signInId);
    if (!target) return 'not_found';
    if (target.id === own?.id) return 'current';
    if (own?.letIn !== 'yes') return 'actor_not_let_in';
    if (target.letIn === 'no') return 'not_let_in';
    await tx
      .delete(letInSignIns)
      .where(and(eq(letInSignIns.orgId, member.orgId), eq(letInSignIns.signInId, target.id)));
    await audit(tx, member, actor, target.id, 'member_sign_in.let_in_withdrawn', {
      was: target.letIn,
    });
    return 'withdrawn';
  });
}
