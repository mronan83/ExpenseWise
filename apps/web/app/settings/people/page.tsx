'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { useFeatures } from '../../../lib/features';
import { formText } from '../../../lib/form';
import {
  approverNote,
  ROLES,
  roleName,
  shortDate,
  whose,
  type CreatedInvite,
  type People,
  type Person,
  type Role,
} from '../../../lib/people';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & People);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * The people in the organization (FR-PLT-07, #29): their roles, invite links, and removing
 * someone; while approval is on, who approves each person's reports (#86). Owners only, while
 * Invite people is switched on.
 */
export default function PeoplePage() {
  const on = useFeatures();
  const approvalOn = on('reports.approval');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; role: Role } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      setLoad({ state: 'ready', ...(await api<People>('/v1/settings/people')) });
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'feature_off') {
        setLoad({
          state: 'unavailable',
          message:
            'Inviting people isn’t switched on. The owner can switch on Invite people in Features.',
        });
      } else if (error instanceof ApiProblem && error.code === 'forbidden_role') {
        setLoad({
          state: 'unavailable',
          message: 'Only your organization’s owner manages people.',
        });
      } else {
        setLoad({ state: 'error', message: describeError(error) });
      }
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await action() });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const role = formText(data, 'role') as Role;
    const label = formText(data, 'label').trim();
    void run(async () => {
      const made = await api<CreatedInvite>('/v1/settings/people/invites', {
        method: 'POST',
        body: JSON.stringify({ role, ...(label ? { label } : {}) }),
      });
      setLink({ url: `${window.location.origin}${made.path}`, role });
      form.reset();
      return `A link for a new ${roleName(role).toLowerCase()} is ready below.`;
    });
  };

  const changeRole = (person: Person, role: Role) =>
    void run(async () => {
      await api(`/v1/settings/people/${person.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      return `${person.name} is now ${roleName(role).toLowerCase()}.`;
    });

  const chooseApprover = (person: Person, approverId: string) =>
    void run(async () => {
      const after = await api<Person>(`/v1/settings/people/${person.id}/approver`, {
        method: 'PUT',
        body: JSON.stringify({ approverId: approverId || null }),
      });
      const goesTo = after.approver?.goesTo?.name;
      const reports = `${whose(person)} reports`;
      if (!approverId) {
        return goesTo
          ? `Automatic: ${reports} go to ${goesTo}.`
          : `Automatic: no one else can approve ${reports} yet.`;
      }
      return `${goesTo ?? 'The one you chose'} approves ${reports} from now on. Any already submitted stay with whoever has them.`;
    });

  const remove = (person: Person) =>
    void run(async () => {
      await api(`/v1/settings/people/${person.id}`, { method: 'DELETE' });
      setRemoving(null);
      return `${person.name} is removed. Their receipts, expenses and trips stay.`;
    });

  const revoke = (id: string) =>
    void run(async () => {
      await api(`/v1/settings/people/invites/${id}`, { method: 'DELETE' });
      return 'That link no longer works.';
    });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage({ tone: 'ok', text: 'The link is copied.' });
    } catch {
      setMessage({ tone: 'warn', text: 'Copying failed: select the link and copy it.' });
    }
  }

  const active = load.state === 'ready' ? load.people.filter((p) => !p.removedAt) : [];
  const gone = load.state === 'ready' ? load.people.filter((p) => p.removedAt) : [];
  const you = active.find((p) => p.you)?.id;

  /** Who approves this person's reports (#86): Automatic, or someone else who can approve. */
  const approverChoice = (person: Person, a: NonNullable<Person['approver']>) => {
    const note = approverNote(person);
    const lost = a.chosen && !a.choices.some((c) => c.id === a.chosen!.id) ? a.chosen : null;
    return (
      <span className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Who approves {whose(person)} reports
          <select
            value={a.chosen?.id ?? ''}
            disabled={busy}
            onChange={(e) => chooseApprover(person, e.target.value)}
            className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
          >
            <option value="">Automatic</option>
            {a.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.id === you ? ' (you)' : ''}
              </option>
            ))}
            {lost ? (
              <option value={lost.id} disabled>
                {lost.name}, who can’t approve now
              </option>
            ) : null}
          </select>
        </label>
        {note ? (
          <span className={`text-xs ${note.warn ? 'text-warn' : 'text-ink-2'}`}>{note.text}</span>
        ) : null}
      </span>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/people" />
        <h1 className="text-2xl font-bold">People</h1>
        <p className="text-sm text-ink-2">
          Invite someone with a link and a role. Each person sees and changes their own receipts,
          expenses and trips. Owners, finance admins and auditors can also open everyone&apos;s; an
          auditor changes nothing.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to manage people.
          </p>
        ) : null}
        {load.state === 'unavailable' ? <p className="text-sm">{load.message}</p> : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <section
              aria-labelledby="people-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="people-title" className="font-semibold">
                In your organization
              </h2>
              {approvalOn && active.some((p) => p.approver) ? (
                <p className="text-sm text-ink-2">
                  Choose who approves each person&apos;s reports, or leave it on Automatic: the
                  longest-standing approver, then a finance admin, then an owner. No one approves
                  their own.
                </p>
              ) : null}
              <ul className="flex flex-col divide-y divide-rule">
                {active.map((p) => (
                  <li key={p.id} className="flex flex-col gap-2 py-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">
                        {p.name}
                        {p.you ? ' (you)' : ''}
                      </span>
                      <span className="truncate text-xs text-ink-2">
                        {p.email} · joined {shortDate(p.joinedAt)}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Role of ${p.name}`}
                        value={p.role}
                        disabled={busy}
                        onChange={(e) => changeRole(p, e.target.value as Role)}
                        className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
                      >
                        {ROLES.map((r) => (
                          <option key={r.role} value={r.role}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      {p.you ? null : removing === p.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => remove(p)}
                            disabled={busy}
                            className="min-h-11 rounded-lg bg-carbon px-3 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                          >
                            Remove {p.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRemoving(null)}
                            className="min-h-11 rounded-lg border border-rule px-3 text-sm font-semibold"
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setRemoving(p.id)}
                          disabled={busy}
                          aria-label={`Remove ${p.name}`}
                          className="min-h-11 rounded-lg border border-rule px-3 text-sm font-semibold disabled:opacity-60"
                        >
                          Remove
                        </button>
                      )}
                    </span>
                    {removing === p.id ? (
                      <span className="text-xs text-ink-2">
                        They can no longer sign in here. Their receipts, expenses, trips and history
                        stay.
                      </span>
                    ) : null}
                    {approvalOn && p.approver ? approverChoice(p, p.approver) : null}
                  </li>
                ))}
              </ul>
              {gone.length > 0 ? (
                <>
                  <h3 className="text-sm font-semibold">Removed</h3>
                  <ul className="flex flex-col gap-1">
                    {gone.map((p) => (
                      <li key={p.id} className="text-xs text-ink-2">
                        {p.name} ({p.email}), {roleName(p.role).toLowerCase()}, removed{' '}
                        {shortDate(p.removedAt!)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>

            <section
              aria-labelledby="invite-title"
              className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
            >
              <h2 id="invite-title" className="font-semibold">
                Invite someone
              </h2>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-2">
                <li>
                  Sign-ups are off, so first make their account in the Supabase dashboard
                  (Authentication › Users › Add user) with their email and a password, and give them
                  both.
                </li>
                <li>Make a link here with the role they should have, and send it to them.</li>
                <li>They sign in and open the link within 7 days. It works once.</li>
              </ol>
              <form onSubmit={invite} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Role
                  <select
                    name="role"
                    defaultValue="member"
                    className="min-h-11 rounded-lg border border-rule bg-paper px-3 text-base text-ink"
                  >
                    {ROLES.map((r) => (
                      <option key={r.role} value={r.role}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="text-sm">
                  <summary className="tap cursor-pointer font-medium">
                    What each role can do
                  </summary>
                  <dl className="mt-2 flex flex-col gap-1 text-ink-2">
                    {ROLES.map((r) => (
                      <div key={r.role}>
                        <dt className="inline font-medium text-ink">{r.name}: </dt>
                        <dd className="inline">{r.does}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Who it is for (optional)
                  <input
                    name="label"
                    maxLength={80}
                    autoComplete="off"
                    className="rounded-lg border border-rule bg-paper px-3 py-2 text-base"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                >
                  {busy ? 'Working…' : 'Make a link'}
                </button>
              </form>
              {link ? (
                <div className="flex flex-col gap-2 rounded-lg border border-rule p-3">
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Link for a new {roleName(link.role).toLowerCase()}
                    <input
                      readOnly
                      value={link.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void copy(link.url)}
                    className="min-h-11 rounded-lg border border-rule px-3 text-sm font-semibold"
                  >
                    Copy the link
                  </button>
                  <p className="text-xs text-ink-2">
                    It is shown only now. Whoever signs in and opens it joins as{' '}
                    {roleName(link.role).toLowerCase()}, so send it only to them.
                  </p>
                </div>
              ) : null}
            </section>

            {load.invites.length > 0 ? (
              <section
                aria-labelledby="links-title"
                className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5"
              >
                <h2 id="links-title" className="font-semibold">
                  Links not used yet
                </h2>
                <ul className="flex flex-col divide-y divide-rule">
                  {load.invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">
                          {i.label ?? 'A link'} · {roleName(i.role)}
                        </span>
                        <span className="text-xs text-ink-2">
                          {i.expired
                            ? `Expired ${shortDate(i.expiresAt)}`
                            : `Works until ${shortDate(i.expiresAt)}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => revoke(i.id)}
                        disabled={busy}
                        aria-label={`Revoke the link${i.label ? ` ${i.label}` : ''}`}
                        className="min-h-11 shrink-0 rounded-lg border border-rule px-3 text-sm font-semibold disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
        <p
          role="status"
          className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
        >
          {message?.text}
        </p>
      </main>
    </div>
  );
}
