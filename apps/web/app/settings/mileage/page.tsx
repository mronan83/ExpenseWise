'use client';

import { ROUTE_ATTRIBUTION, showDateTime } from '@expensewise/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { loadFeatures } from '../../../lib/features';
import { formText } from '../../../lib/form';
import { MILEAGE_FLAG } from '../../../lib/mileage';
import {
  PLACE_NAME_MAX,
  ROUTE_ADDRESS_MAX,
  ROUTE_MILEAGE_FLAG,
  type RouteKeyStatus,
  type SavedPlace,
} from '../../../lib/route-mileage';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'off' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      /** Route mileage is on (FR-CAP-04); otherwise only mileage is. */
      routes: boolean;
      /** The key, or null for a member who isn't an owner or finance admin. */
      key: RouteKeyStatus | null;
      places: SavedPlace[];
    };

type Message = { tone: 'ok' | 'warn'; text: string } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

/**
 * Settings › Mileage: how drives are measured and paid. With route mileage on (Q31), the
 * organization's OpenRouteService key, kept by owners and finance admins, and each person's
 * saved places.
 */
export default function MileageSettingsPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      const { features } = await loadFeatures();
      const on = (key: string) => features.some((f) => f.key === key && f.enabled);
      if (!on(ROUTE_MILEAGE_FLAG)) {
        setLoad(
          on(MILEAGE_FLAG)
            ? { state: 'ready', routes: false, key: null, places: [] }
            : { state: 'off' },
        );
        return;
      }
      const key = await api<RouteKeyStatus>('/v1/settings/mileage/route-key').catch(
        (error: unknown) => {
          // A member who isn't an owner or finance admin sees whether there is a key, not it.
          if (error instanceof ApiProblem && error.code === 'forbidden_role') return null;
          throw error;
        },
      );
      const { places } = await api<{ places: SavedPlace[] }>('/v1/me/places');
      setLoad({ state: 'ready', routes: true, key, places });
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
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/mileage" />
        <h1 className="text-2xl font-bold">Mileage</h1>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to change mileage settings.
          </p>
        ) : null}
        {load.state === 'off' ? (
          <p className="text-sm">
            Mileage is switched off for your organization. Its owner can switch it on in{' '}
            <Link href="/settings/features" className="font-semibold text-carbon underline">
              Settings › Features
            </Link>
            .
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {/* Rate a mile (#77) goes here, above route measuring, from ./rate-section.tsx. */}
        {load.state === 'ready' && load.routes ? (
          <>
            <RouteMeasuring status={load.key} onChange={(key) => setLoad({ ...load, key })} />
            <SavedPlaces places={load.places} onChange={(places) => setLoad({ ...load, places })} />
          </>
        ) : null}
      </main>
    </div>
  );
}

/** The organization's OpenRouteService key (Q31): checked on save, stored encrypted. */
function RouteMeasuring({
  status,
  onChange,
}: {
  status: RouteKeyStatus | null;
  onChange: (next: RouteKeyStatus) => void;
}) {
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = formText(new FormData(form), 'apiKey').trim();
    void run(async () => {
      const next = await api<RouteKeyStatus>('/v1/settings/mileage/route-key', {
        method: 'PUT',
        body: JSON.stringify({ apiKey }),
      });
      form.reset();
      onChange(next);
      setMessage({ tone: 'ok', text: 'OpenRouteService accepted the key. It is saved.' });
    });
  };

  const remove = () =>
    void run(async () => {
      await api('/v1/settings/mileage/route-key', { method: 'DELETE' });
      onChange({
        provider: 'openrouteservice',
        configured: false,
        keyHint: null,
        verifiedAt: null,
        updatedAt: null,
      });
      setMessage({
        tone: 'ok',
        text: 'The key is removed. New drives by route can’t be measured.',
      });
    });

  return (
    <section
      aria-labelledby="route-measuring-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5 text-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="route-measuring-title" className="text-base font-semibold">
          Route measuring
        </h2>
        {status ? (
          <span className="text-ink-2">
            {status.configured ? `Key ending ${status.keyHint}` : 'No key'}
          </span>
        ) : null}
      </div>
      <p className="text-ink-2">
        A drive added by its route is measured by car with OpenRouteService, a free routing service
        run by HeiGIT on OpenStreetMap’s map data. Its free Standard key is enough: about 1,000
        address lookups and 2,000 routes a day, with no card. Each drive looks up each of its stops
        once and asks for one route.
      </p>
      {status === null ? (
        <p className="text-ink-2">
          Your organization’s owner or a finance admin keeps its OpenRouteService key here.
        </p>
      ) : (
        <>
          <p className="text-ink-2">
            Sign up at{' '}
            <a
              href="https://openrouteservice.org/dev/#/signup"
              target="_blank"
              rel="noreferrer"
              className="text-carbon underline"
            >
              openrouteservice.org
            </a>
            , copy your key from its dashboard and paste it here. It is checked with one short route
            when you save it, stored encrypted, and never shown again: only its last four
            characters.
          </p>
          {status.verifiedAt ? (
            <p className="text-ink-2">Accepted {showDateTime(status.verifiedAt)}</p>
          ) : null}
          <form onSubmit={save} className="flex flex-col gap-2">
            <label htmlFor="route-key" className="font-medium">
              {status.configured ? 'Replace the OpenRouteService key' : 'OpenRouteService key'}
            </label>
            <input
              id="route-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              minLength={8}
              className="rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
              >
                {busy ? 'Working…' : 'Check and save'}
              </button>
              {status.configured ? (
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </form>
          <p
            role="status"
            className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
          >
            {message?.text}
          </p>
        </>
      )}
      <p className="text-xs text-ink-2">{ROUTE_ATTRIBUTION}</p>
    </section>
  );
}

/** A person's saved places, to pick for a drive's stops: only the address is used. */
function SavedPlaces({
  places,
  onChange,
}: {
  places: SavedPlace[];
  onChange: (next: SavedPlace[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: 'warn', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  const byName = (list: SavedPlace[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const place = await api<SavedPlace>('/v1/me/places', {
        method: 'POST',
        body: JSON.stringify({ name: formText(data, 'name'), address: formText(data, 'address') }),
      });
      form.reset();
      onChange(byName([...places, place]));
      setMessage({ tone: 'ok', text: `${place.name} is saved.` });
    });
  };

  const change = (id: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const place = await api<SavedPlace>(`/v1/me/places/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: formText(data, 'name'), address: formText(data, 'address') }),
      });
      onChange(byName(places.map((p) => (p.id === id ? place : p))));
      setEditing(null);
      setMessage({ tone: 'ok', text: `${place.name} is saved.` });
    });
  };

  const remove = (place: SavedPlace) =>
    void run(async () => {
      await api(`/v1/me/places/${place.id}`, { method: 'DELETE' });
      onChange(places.filter((p) => p.id !== place.id));
      setMessage({ tone: 'ok', text: `${place.name} is removed.` });
    });

  const field = 'w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base';
  const label = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2';
  const fields = (place?: SavedPlace) => (
    <>
      <label className={label}>
        Name
        <input
          name="name"
          required
          maxLength={PLACE_NAME_MAX}
          autoComplete="off"
          placeholder="Home"
          defaultValue={place?.name}
          className={field}
        />
      </label>
      <label className={label}>
        Address
        <input
          name="address"
          required
          maxLength={ROUTE_ADDRESS_MAX}
          autoComplete="off"
          placeholder="12 Elm St, Omaha, NE"
          defaultValue={place?.address}
          className={field}
        />
      </label>
    </>
  );

  return (
    <section
      aria-labelledby="places-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-5 text-sm"
    >
      <h2 id="places-title" className="text-base font-semibold">
        Saved places
      </h2>
      <p className="text-ink-2">
        Places you start or end drives from, such as Home or Office, to pick for a stop. Only your
        own; only the address is used for a drive, and the name stays here.
      </p>
      {places.length === 0 ? <p className="text-ink-2">No places saved yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {places.map((place) =>
          editing === place.id ? (
            <li key={place.id}>
              <form onSubmit={change(place.id)} className="flex flex-col gap-2">
                {fields(place)}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </li>
          ) : (
            <li key={place.id} className="flex flex-col gap-1">
              <span className="font-semibold">{place.name}</span>
              <span className="break-words text-ink-2">{place.address}</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(place.id)}
                  aria-label={`Edit ${place.name}`}
                  className="tap rounded-lg border border-rule px-3 py-1.5 text-xs font-semibold"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(place)}
                  disabled={busy}
                  aria-label={`Remove ${place.name}`}
                  className="tap rounded-lg border border-rule px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      <form onSubmit={add} className="flex flex-col gap-2 border-t border-rule pt-3">
        <h3 className="text-sm font-semibold">Add a place</h3>
        {fields()}
        <div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
          >
            Save the place
          </button>
        </div>
      </form>
      <p
        role="status"
        className={`min-h-5 text-sm ${message?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
      >
        {message?.text}
      </p>
    </section>
  );
}
