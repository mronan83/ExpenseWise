'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { roleName, shortDate, type InvitePreview } from '../../../lib/people';
import { supabase } from '../../../lib/supabase';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'gone'; message: string }
  | { state: 'ready'; invite: InvitePreview }
  | { state: 'joined'; organization: string; role: string };

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const STATE_TEXT: Record<Exclude<InvitePreview['state'], 'pending'>, string> = {
  accepted: 'This invite link was already used. Ask the organization’s owner for a new one.',
  revoked: 'This invite link was revoked. Ask the organization’s owner for a new one.',
  expired: 'This invite link has expired. Ask the organization’s owner for a new one.',
};

/**
 * Opening an invite link (FR-PLT-07, #29): a signed-in person sees what it offers and joins the
 * organization with its role. Nothing here makes an organization of their own.
 */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      const invite = await api<InvitePreview>('/v1/invites/look-up', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setLoad({ state: 'ready', invite });
    } catch (failure) {
      const absent =
        failure instanceof ApiProblem && (failure.status === 404 || failure.status === 400);
      setLoad({
        state: 'gone',
        message: absent
          ? 'This invite link doesn’t work. Check you have the whole link, or ask for a new one.'
          : describeError(failure),
      });
    }
  }, [token]);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const joined = await api<{ organization: { name: string }; member: { role: string } }>(
        '/v1/invites/accept',
        { method: 'POST', body: JSON.stringify({ token }) },
      );
      setLoad({
        state: 'joined',
        organization: joined.organization.name,
        role: joined.member.role,
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  const invite = load.state === 'ready' ? load.invite : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <h1 className="text-2xl font-bold">
          {invite ? `Join ${invite.organization.name}` : 'An invite to ExpenseWise'}
        </h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <>
            <p className="text-sm">
              You have been invited to join an organization. There is no sign-up: the
              organization&apos;s owner made your account and sent you its email and password.
            </p>
            <p className="text-sm">
              <Link
                href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}
                className="tap font-semibold text-carbon underline"
              >
                Sign in
              </Link>{' '}
              with it, and you will come back here to join.
            </p>
          </>
        ) : null}
        {load.state === 'gone' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {invite ? (
          <section
            aria-labelledby="invite-offer"
            className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
          >
            <h2 id="invite-offer" className="font-semibold">
              As {roleName(invite.role).toLowerCase()}
            </h2>
            {invite.standing === 'this' ? (
              <p className="text-sm">
                You are already in {invite.organization.name}.{' '}
                <Link href="/" className="tap font-semibold text-carbon underline">
                  Go to Home
                </Link>
              </p>
            ) : invite.state !== 'pending' ? (
              <p className="text-sm">{STATE_TEXT[invite.state]}</p>
            ) : invite.standing === 'not_empty' ? (
              <p className="text-sm">
                You already have receipts, settings or other people in an organization of your own,
                and joining would leave them behind, so this account can&apos;t join. Ask the owner
                to invite another email of yours instead.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-2">
                  You will see and change your own receipts, expenses and trips there.
                  {invite.standing === 'empty'
                    ? ' The empty organization made when you first signed in is left behind.'
                    : ''}{' '}
                  The link works until {shortDate(invite.expiresAt)}.
                </p>
                <button
                  type="button"
                  onClick={() => void join()}
                  disabled={busy}
                  className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                >
                  {busy ? 'Joining…' : `Join ${invite.organization.name}`}
                </button>
              </>
            )}
          </section>
        ) : null}
        {load.state === 'joined' ? (
          <p role="status" className="text-sm text-ok">
            You joined {load.organization} as{' '}
            {roleName(load.role as InvitePreview['role']).toLowerCase()}.{' '}
            <Link href="/" className="tap font-semibold text-carbon underline">
              Go to Home
            </Link>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-warn">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
