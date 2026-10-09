'use client';

import {
  ORGANIZATION_SIZES,
  SUPPORTED_CURRENCIES,
  type MemberRole,
  type OrganizationSize,
} from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { CATEGORIES_FLAG, type Catalog } from '../../../lib/categories';
import { COMPANY_PAID_FLAG } from '../../../lib/company-paid';
import { timeZones } from '../../../lib/expenses';
import type { FeatureList } from '../../../lib/features';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';
import { Wordmark } from '../../brand';

interface Details {
  id: string;
  name: string;
  homeCurrency: string;
  country: string | null;
  locale: string | null;
  timeZone: string | null;
  address: string | null;
  industry: string | null;
  size: OrganizationSize | null;
}

interface OrganizationSettings {
  organization: Details;
  role: MemberRole;
  canEdit: boolean;
}

interface DuplicateWindow {
  minutes: number;
  defaultMinutes: number;
  maxMinutes: number;
  canEdit: boolean;
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      role: MemberRole;
      email: string | null;
      /** Null while its feature is off. */
      settings: OrganizationSettings | null;
      duplicateWindow: DuplicateWindow | null;
      /**
       * The types the company pays directly (FR-EXP-18): null while Paid by the company is off;
       * 'no-categories' while it is on and categories, which the types belong to, are off.
       */
      companyPays: Catalog | 'no-categories' | null;
    };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const ROLES: Record<MemberRole, string> = {
  owner: 'Owner',
  finance_admin: 'Finance admin',
  approver: 'Approver',
  member: 'Member',
  auditor: 'Auditor',
};

const SIZES: Record<OrganizationSize, string> = {
  just_me: 'Just me',
  '2_10': '2 to 10 people',
  '11_50': '11 to 50 people',
  '51_200': '51 to 200 people',
  '201_1000': '201 to 1,000 people',
  over_1000: 'More than 1,000 people',
};

type Field = Exclude<keyof Details, 'id'>;
type Draft = Record<Field, string>;

const LABELS: Record<Field, string> = {
  name: 'Name',
  homeCurrency: 'Home currency',
  country: 'Country',
  locale: 'Locale',
  timeZone: 'Time zone',
  address: 'Address',
  industry: 'Industry',
  size: 'Size',
};

const draftOf = (d: Details): Draft => ({
  name: d.name,
  homeCurrency: d.homeCurrency,
  country: d.country ?? '',
  locale: d.locale ?? '',
  timeZone: d.timeZone ?? '',
  address: d.address ?? '',
  industry: d.industry ?? '',
  size: d.size ?? '',
});

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const inputClass = 'rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
const labelClass = 'flex flex-col gap-1 text-xs font-medium text-ink-2';

/**
 * Settings › Organization (FR-PLT-11, FR-INT-19, FR-EXP-18): the caller's role, then the
 * organization's details, its duplicate time window and the types the company pays directly,
 * each shown only while its feature is on. Every member reads them; only the owner changes the
 * first two, and owners and finance admins the last.
 */
export default function OrganizationSettingsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      const { member } = await api<{ member: { role: MemberRole } }>('/v1/me/organization', {
        method: 'POST',
      });
      const { features } = await api<FeatureList>('/v1/features');
      const on = (key: string) => features.some((f) => f.key === key && f.enabled);
      const [settings, duplicateWindow, companyPays] = await Promise.all([
        on('settings.organization') ? api<OrganizationSettings>('/v1/settings/organization') : null,
        on('settings.duplicate-window')
          ? api<DuplicateWindow>('/v1/settings/duplicate-window')
          : null,
        !on(COMPANY_PAID_FLAG)
          ? null
          : on(CATEGORIES_FLAG)
            ? api<Catalog>('/v1/categories')
            : ('no-categories' as const),
      ]);
      setLoad({
        state: 'ready',
        role: member.role,
        email: session.user.email ?? null,
        settings,
        duplicateWindow,
        companyPays,
      });
    } catch (error) {
      setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/organization" />
        <h1 className="text-2xl font-bold">Organization</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your organization.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            <Card id="role" title="Your role">
              <p>
                {load.email ? (
                  <>
                    Signed in as <span className="font-medium break-all">{load.email}</span>, you
                    are{' '}
                  </>
                ) : (
                  'You are '
                )}
                <span className="font-semibold">{ROLES[load.role]}</span>.
              </p>
              <p className="text-xs text-ink-2">
                A role belongs to you, not to an address: each of your{' '}
                <Link href="/settings/sign-ins" className="tap text-carbon underline">
                  sign-ins
                </Link>{' '}
                carries it.
              </p>
            </Card>
            {load.settings ? (
              <DetailsCard settings={load.settings} onSaved={() => void refresh()} />
            ) : null}
            {load.duplicateWindow ? (
              <WindowCard setting={load.duplicateWindow} onSaved={() => void refresh()} />
            ) : null}
            {load.companyPays ? <CompanyPaysCard catalog={load.companyPays} /> : null}
            {!load.settings && !load.duplicateWindow && !load.companyPays ? (
              <p className="text-sm text-ink-2">
                Organization settings aren’t switched on. The owner switches them on in{' '}
                <Link href="/settings/features" className="tap text-carbon underline">
                  Features
                </Link>
                .
              </p>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5 text-sm"
    >
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Status({ message }: { message: Message }) {
  return (
    <p
      role="status"
      className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
    >
      {message?.text}
    </p>
  );
}

function DetailsCard({
  settings,
  onSaved,
}: {
  settings: OrganizationSettings;
  onSaved: () => void;
}) {
  const org = settings.organization;
  const [draft, setDraft] = useState<Draft>(() => draftOf(org));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  if (!settings.canEdit) {
    const rows: [Field, string | null][] = [
      ['name', org.name],
      ['homeCurrency', org.homeCurrency],
      ['country', org.country],
      ['locale', org.locale],
      ['timeZone', org.timeZone?.replaceAll('_', ' ') ?? null],
      ['address', org.address],
      ['industry', org.industry],
      ['size', org.size ? SIZES[org.size] : null],
    ];
    return (
      <Card id="details" title="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {rows.map(([field, value]) => (
            <Row key={field} label={LABELS[field]} value={value} />
          ))}
        </dl>
        <p className="text-xs text-ink-2">Only your organization’s owner can change these.</p>
      </Card>
    );
  }

  const set = (field: Field) => (value: string) => setDraft({ ...draft, [field]: value });
  const before = draftOf(org);
  const changed = (Object.keys(draft) as Field[]).filter((f) => draft[f] !== before[f]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const edit = Object.fromEntries(changed.map((f) => [f, draft[f]]));
      const saved = await api<OrganizationSettings>('/v1/settings/organization', {
        method: 'PATCH',
        body: JSON.stringify(edit),
      });
      setDraft(draftOf(saved.organization));
      setMessage({ tone: 'ok', text: 'Saved.' });
      onSaved();
    } catch (error) {
      const field = error instanceof ApiProblem ? error.extra.field : undefined;
      const label = typeof field === 'string' && field in LABELS ? LABELS[field as Field] : null;
      setMessage({
        tone: 'warn',
        text: label ? `${label}: ${describeError(error)}` : describeError(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="details" title="Details">
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
        <label className={labelClass}>
          {LABELS.name}
          <input
            name="name"
            value={draft.name}
            onChange={(e) => set('name')(e.target.value)}
            required
            maxLength={200}
            autoComplete="organization"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          {LABELS.homeCurrency}
          <select
            name="homeCurrency"
            value={draft.homeCurrency}
            onChange={(e) => set('homeCurrency')(e.target.value)}
            className={inputClass}
          >
            {SUPPORTED_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <span className="font-normal">
            Reports opened from now on are in it. Reports already opened keep theirs, and no amount
            is converted.
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClass}>
            {LABELS.country}
            <input
              name="country"
              value={draft.country}
              onChange={(e) => set('country')(e.target.value)}
              maxLength={2}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="US"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            {LABELS.locale}
            <input
              name="locale"
              value={draft.locale}
              onChange={(e) => set('locale')(e.target.value)}
              maxLength={35}
              autoComplete="off"
              placeholder="en-US"
              className={inputClass}
            />
          </label>
        </div>
        <label className={labelClass}>
          {LABELS.timeZone}
          <select
            name="timeZone"
            value={draft.timeZone}
            onChange={(e) => set('timeZone')(e.target.value)}
            className={inputClass}
          >
            <option value="">Not set</option>
            {timeZones(org.timeZone).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          <span className="font-normal">
            When your day ends: trips and local expenses join a report 24 hours after their day ends
            here, and a report’s day 28 is counted on this calendar.
          </span>
        </label>
        <label className={labelClass}>
          {LABELS.address}
          <textarea
            name="address"
            value={draft.address}
            onChange={(e) => set('address')(e.target.value)}
            maxLength={300}
            rows={3}
            autoComplete="street-address"
            className={inputClass}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClass}>
            {LABELS.industry}
            <input
              name="industry"
              value={draft.industry}
              onChange={(e) => set('industry')(e.target.value)}
              maxLength={100}
              autoComplete="off"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            {LABELS.size}
            <select
              name="size"
              value={draft.size}
              onChange={(e) => set('size')(e.target.value)}
              className={inputClass}
            >
              <option value="">Not set</option>
              {ORGANIZATION_SIZES.map((size) => (
                <option key={size} value={size}>
                  {SIZES[size]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={busy || changed.length === 0}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save details'}
          </button>
        </div>
      </form>
      <Status message={message} />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words whitespace-pre-line">{value ?? 'Not set'}</dd>
    </>
  );
}

function WindowCard({ setting, onSaved }: { setting: DuplicateWindow; onSaved: () => void }) {
  const [minutes, setMinutes] = useState(String(setting.minutes));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const explain = (
    <p className="text-ink-2">
      Two receipts from the same place, this many minutes apart or less, are held as one purchase
      for a look. 0 means the same minute only; {setting.defaultMinutes} is where it starts. A
      change judges receipts read from then on; pairs already decided stay as they are.
    </p>
  );

  if (!setting.canEdit) {
    return (
      <Card id="window" title="Duplicate time window">
        <p className="text-base font-semibold">{minutesText(setting.minutes)}</p>
        {explain}
        <p className="text-xs text-ink-2">Only your organization’s owner can change it.</p>
      </Card>
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<DuplicateWindow>('/v1/settings/duplicate-window', {
        method: 'PUT',
        body: JSON.stringify({ minutes: Number(minutes) }),
      });
      setMinutes(String(saved.minutes));
      setMessage({
        tone: 'ok',
        text: `Saved: ${minutesText(saved.minutes)}, for everyone in your organization.`,
      });
      onSaved();
    } catch (error) {
      setMessage({
        tone: 'warn',
        text:
          error instanceof ApiProblem && error.status === 400
            ? `Enter a whole number of minutes, 0 to ${setting.maxMinutes}.`
            : describeError(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="window" title="Duplicate time window">
      {explain}
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Minutes, 0 to {setting.maxMinutes}
          <input
            name="minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={setting.maxMinutes}
            step={1}
            required
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className={`${inputClass} w-28`}
          />
        </label>
        <button
          type="submit"
          disabled={busy || minutes === String(setting.minutes)}
          className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save window'}
        </button>
      </form>
      <Status message={message} />
    </Card>
  );
}

/**
 * The types the company pays directly (FR-EXP-18, Q46): each active type with a checkbox. An
 * expense of a ticked type is paid by the company, stays on its trip and is never claimed,
 * unless a person sets it by hand. A change reaches every expense not yet on a submitted
 * report (Q48). Owners and finance admins change it; everyone else reads it.
 */
function CompanyPaysCard({ catalog }: { catalog: Catalog | 'no-categories' }) {
  const [types, setTypes] = useState(() =>
    catalog === 'no-categories' ? [] : catalog.types.filter((t) => t.active),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const explain = (
    <p className="text-ink-2">
      An expense of a ticked type, such as airfare your employer books, is paid by the company: it
      stays on its trip and in the trip’s cost, and is never claimed. Anyone can switch one expense
      either way. A change here reaches every expense not yet on a submitted report, except one
      switched by hand.
    </p>
  );

  if (catalog === 'no-categories') {
    return (
      <Card id="company-pays" title="Paid by the company directly">
        {explain}
        <p className="text-ink-2">
          It goes by expense type, which comes with categories. The owner switches Categories on in{' '}
          <Link href="/settings/features" className="tap text-carbon underline">
            Features
          </Link>
          .
        </p>
      </Card>
    );
  }

  async function toggle(typeId: string, companyPays: boolean) {
    setBusy(typeId);
    setMessage(null);
    try {
      const saved = await api<{
        id: string;
        name: string;
        companyPays?: boolean;
        switched: number;
      }>(`/v1/settings/expense-types/${typeId}/company-pays`, {
        method: 'PUT',
        body: JSON.stringify({ companyPays }),
      });
      setTypes((list) =>
        list.map((t) => (t.id === typeId ? { ...t, companyPays: saved.companyPays } : t)),
      );
      const n = saved.switched;
      setMessage({
        tone: 'ok',
        text:
          `Saved: the company ${companyPays ? 'pays' : 'doesn’t pay'} ${saved.name} directly. ` +
          (n === 0
            ? 'No expense needed to change.'
            : `${n} ${n === 1 ? 'expense' : 'expenses'} followed it.`),
      });
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="company-pays" title="Paid by the company directly">
      {explain}
      <fieldset className="flex flex-col">
        <legend className="sr-only">Types the company pays directly</legend>
        {types.map((t) => (
          <label
            key={t.id}
            className="flex min-h-11 items-center gap-3"
            style={{ paddingLeft: `${t.depth * 1.25}rem` }}
          >
            <input
              type="checkbox"
              className="size-5"
              checked={t.companyPays ?? false}
              disabled={!catalog.canManage || busy !== null}
              onChange={(e) => void toggle(t.id, e.target.checked)}
            />
            <span className="break-words">{t.name}</span>
          </label>
        ))}
      </fieldset>
      {catalog.canManage ? null : (
        <p className="text-xs text-ink-2">Only an owner or finance admin can change it.</p>
      )}
      <Status message={message} />
    </Card>
  );
}

function minutesText(minutes: number): string {
  if (minutes === 0) return 'The same minute only';
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
