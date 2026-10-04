'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiProblem } from '../../../lib/api';
import { indented, type Catalog, type Category, type ExpenseType } from '../../../lib/categories';
import { supabase } from '../../../lib/supabase';
import { SettingsNav } from '../nav';

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'off' }
  | { state: 'error'; message: string }
  | ({ state: 'ready' } & Catalog);

type Message = { tone: 'ok' | 'warn'; text: string } | null;

/** What is being edited: a category or a type, a new one when `id` is null. */
type Editing = { kind: 'category' | 'type'; id: string | null } | null;

const describeError = (error: unknown) =>
  error instanceof ApiProblem
    ? [error.message, error.detail].filter(Boolean).join('. ')
    : 'Something went wrong. Try again.';

const field = 'rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink';
const label = 'flex flex-col gap-1 text-xs font-medium text-ink-2';

/**
 * Settings › Categories (FR-EXP-11, Q7): the organization's categories and types, two lists
 * that each nest, and which types each category allows. Owners and finance admins add, rename,
 * move and retire them; one in use is retired, never deleted, so old claims keep it.
 */
export default function CategoriesPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState<Message>(null);

  const refresh = useCallback(async () => {
    const session = (await supabase()?.auth.getSession())?.data.session;
    if (!session) {
      setLoad({ state: 'signed-out' });
      return;
    }
    try {
      await api('/v1/me/organization', { method: 'POST' });
      setLoad({ state: 'ready', ...(await api<Catalog>('/v1/categories')) });
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'feature_off') setLoad({ state: 'off' });
      else setLoad({ state: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    // Loading reads the browser's session, so it can only start after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const done = async (text: string) => {
    setEditing(null);
    setMessage({ tone: 'ok', text });
    await refresh();
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-baseline justify-between py-3">
        <Link href="/" className="tap font-mono text-xs tracking-widest text-ink-2 uppercase">
          ExpenseWise
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-4 pb-8">
        <SettingsNav current="/settings/categories" />
        <h1 className="text-2xl font-bold">Categories and types</h1>
        <p className="text-sm text-ink-2">
          Every expense gets a category, where finance books it, and a type, what was bought. A
          category offers only the types it allows.
        </p>
        {load.state === 'loading' ? <p className="text-sm text-ink-2">Loading…</p> : null}
        {load.state === 'signed-out' ? (
          <p className="text-sm">
            <Link href="/sign-in" className="tap font-semibold text-carbon underline">
              Sign in
            </Link>{' '}
            to see your categories.
          </p>
        ) : null}
        {load.state === 'off' ? (
          <p className="text-sm">
            Categories are switched off. Your organization&apos;s owner can switch them on in{' '}
            <Link href="/settings/features" className="tap font-semibold text-carbon underline">
              Features
            </Link>
            .
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="text-sm text-warn">
            {load.message}
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <>
            {load.canManage ? null : (
              <p className="text-sm text-ink-2">Only an owner or finance admin can change them.</p>
            )}
            <CategoryList
              catalog={load}
              editing={editing}
              onEdit={(id) => {
                setMessage(null);
                setEditing({ kind: 'category', id });
              }}
              onCancel={() => setEditing(null)}
              onDone={done}
            />
            <TypeList
              catalog={load}
              editing={editing}
              onEdit={(id) => {
                setMessage(null);
                setEditing({ kind: 'type', id });
              }}
              onCancel={() => setEditing(null)}
              onDone={done}
            />
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

interface ListProps {
  catalog: Catalog;
  editing: Editing;
  onEdit: (id: string | null) => void;
  onCancel: () => void;
  onDone: (text: string) => Promise<void>;
}

const typeNames = (catalog: Catalog, ids: string[]) =>
  ids.map((id) => catalog.types.find((t) => t.id === id)?.name ?? '').filter(Boolean);

/** The ids under a node, itself included: none of them can be its parent. */
function selfAndBelow(nodes: { id: string; parentId: string | null }[], id: string | null) {
  const out = new Set<string>(id ? [id] : []);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

function CategoryList({ catalog, editing, onEdit, onCancel, onDone }: ListProps) {
  const open = editing?.kind === 'category' ? editing : null;
  return (
    <section
      aria-labelledby="categories-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="categories-title" className="text-base font-semibold">
        Categories
      </h2>
      <ul className="flex flex-col divide-y divide-rule">
        {catalog.categories.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 py-3">
            {open?.id === c.id ? (
              <CategoryForm catalog={catalog} category={c} onCancel={onCancel} onDone={onDone} />
            ) : (
              <div className="flex items-start justify-between gap-3">
                <span
                  className="flex min-w-0 flex-col gap-1"
                  style={{ paddingLeft: `${c.depth}rem` }}
                >
                  <span className="font-medium break-words">
                    {c.name}
                    {c.active ? null : <span className="text-ink-2"> · retired</span>}
                  </span>
                  <span className="text-xs text-ink-2">
                    {[c.glCode && `GL ${c.glCode}`, c.taxCode && `Tax ${c.taxCode}`]
                      .filter(Boolean)
                      .join(' · ') || 'No codes'}
                  </span>
                  <span className="text-xs text-ink-2 break-words">
                    Allows: {typeNames(catalog, c.typeIds).join(', ') || 'no types yet'}
                  </span>
                </span>
                {catalog.canManage ? (
                  <button
                    type="button"
                    aria-label={`Edit ${c.name}`}
                    onClick={() => onEdit(c.id)}
                    className="shrink-0 rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold"
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      {open?.id === null ? (
        <CategoryForm catalog={catalog} category={null} onCancel={onCancel} onDone={onDone} />
      ) : catalog.canManage ? (
        <div>
          <button
            type="button"
            onClick={() => onEdit(null)}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
          >
            Add a category
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TypeList({ catalog, editing, onEdit, onCancel, onDone }: ListProps) {
  const open = editing?.kind === 'type' ? editing : null;
  return (
    <section
      aria-labelledby="types-title"
      className="flex flex-col gap-3 rounded-xl border border-rule bg-sheet p-4 text-sm"
    >
      <h2 id="types-title" className="text-base font-semibold">
        Types
      </h2>
      <p className="text-xs text-ink-2">
        A new type is offered once a category allows it: edit the category to choose.
      </p>
      <ul className="flex flex-col divide-y divide-rule">
        {catalog.types.map((t) => (
          <li key={t.id} className="flex flex-col gap-2 py-3">
            {open?.id === t.id ? (
              <TypeForm catalog={catalog} type={t} onCancel={onCancel} onDone={onDone} />
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span
                  className="min-w-0 font-medium break-words"
                  style={{ paddingLeft: `${t.depth}rem` }}
                >
                  {t.name}
                  {t.active ? null : <span className="text-ink-2"> · retired</span>}
                </span>
                {catalog.canManage ? (
                  <button
                    type="button"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => onEdit(t.id)}
                    className="shrink-0 rounded-lg border border-rule px-3 py-1.5 text-sm font-semibold"
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      {open?.id === null ? (
        <TypeForm catalog={catalog} type={null} onCancel={onCancel} onDone={onDone} />
      ) : catalog.canManage ? (
        <div>
          <button
            type="button"
            onClick={() => onEdit(null)}
            className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
          >
            Add a type
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface FormButtonsProps {
  busy: boolean;
  existing: { name: string; active: boolean; inUse: boolean } | null;
  onCancel: () => void;
  onRetire: () => void;
  onDelete: () => void;
}

/** Save and Cancel, and for one that exists, Retire or Restore, and Delete while unused. */
function FormButtons({ busy, existing, onCancel, onRetire, onDelete }: FormButtonsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-carbon px-4 py-2 text-sm font-semibold text-carbon-ink disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold"
      >
        Cancel
      </button>
      {existing ? (
        <button
          type="button"
          disabled={busy}
          onClick={onRetire}
          className="rounded-lg border border-rule px-4 py-2 text-sm font-semibold disabled:opacity-60"
        >
          {existing.active ? 'Retire' : 'Restore'}
        </button>
      ) : null}
      {existing && !existing.inUse ? (
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-warn disabled:opacity-60"
        >
          Delete
        </button>
      ) : null}
    </div>
  );
}

/** Runs one change, says what went wrong, and tells the page when it is done. */
function useChange(onDone: (text: string) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onDone(text);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CategoryForm({
  catalog,
  category,
  onCancel,
  onDone,
}: {
  catalog: Catalog;
  category: Category | null;
  onCancel: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [parentId, setParentId] = useState(category?.parentId ?? '');
  const [glCode, setGlCode] = useState(category?.glCode ?? '');
  const [taxCode, setTaxCode] = useState(category?.taxCode ?? '');
  const [typeIds, setTypeIds] = useState<string[]>(category?.typeIds ?? []);
  const { busy, error, run } = useChange(onDone);
  const excluded = selfAndBelow(catalog.categories, category?.id ?? null);
  const path = category ? `/v1/settings/categories/${category.id}` : '/v1/settings/categories';
  const types = catalog.types.filter((t) => t.active || typeIds.includes(t.id));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = { name, parentId: parentId || null, glCode, taxCode, typeIds };
    void run(
      () => api(path, { method: category ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
      `${name.trim()} is saved.`,
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={category ? `Edit ${category.name}` : 'New category'}
      className="flex flex-col gap-3"
    >
      <label className={label}>
        Name
        <input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          autoComplete="off"
          className={field}
        />
      </label>
      <label className={label}>
        Under
        <select
          name="parentId"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className={field}
        >
          <option value="">Nothing: at the top</option>
          {catalog.categories
            .filter((c) => !excluded.has(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {indented(c)}
              </option>
            ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          GL code
          <input
            name="glCode"
            value={glCode}
            onChange={(e) => setGlCode(e.target.value)}
            maxLength={40}
            autoComplete="off"
            className={`${field} w-full min-w-0`}
          />
        </label>
        <label className={label}>
          Tax code
          <input
            name="taxCode"
            value={taxCode}
            onChange={(e) => setTaxCode(e.target.value)}
            maxLength={40}
            autoComplete="off"
            className={`${field} w-full min-w-0`}
          />
        </label>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-ink">Types it allows</legend>
        {types.map((t) => (
          <label
            key={t.id}
            className="flex min-h-11 items-center gap-2 text-sm"
            style={{ paddingLeft: `${t.depth}rem` }}
          >
            <input
              type="checkbox"
              checked={typeIds.includes(t.id)}
              onChange={(e) =>
                setTypeIds(
                  e.target.checked ? [...typeIds, t.id] : typeIds.filter((x) => x !== t.id),
                )
              }
              className="size-5"
            />
            {t.name}
            {t.active ? null : <span className="text-ink-2">(retired)</span>}
          </label>
        ))}
      </fieldset>
      <FormButtons
        busy={busy}
        existing={category}
        onCancel={onCancel}
        onRetire={() =>
          void run(
            () =>
              api(path, { method: 'PATCH', body: JSON.stringify({ active: !category!.active }) }),
            category!.active
              ? `${category!.name} is retired. Expenses that have it keep it.`
              : `${category!.name} is back in use.`,
          )
        }
        onDelete={() =>
          void run(() => api(path, { method: 'DELETE' }), `${category!.name} is deleted.`)
        }
      />
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TypeForm({
  catalog,
  type,
  onCancel,
  onDone,
}: {
  catalog: Catalog;
  type: ExpenseType | null;
  onCancel: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const [name, setName] = useState(type?.name ?? '');
  const [parentId, setParentId] = useState(type?.parentId ?? '');
  const { busy, error, run } = useChange(onDone);
  const excluded = selfAndBelow(catalog.types, type?.id ?? null);
  const path = type ? `/v1/settings/expense-types/${type.id}` : '/v1/settings/expense-types';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api(path, {
          method: type ? 'PATCH' : 'POST',
          body: JSON.stringify({ name, parentId: parentId || null }),
        }),
      `${name.trim()} is saved.`,
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={type ? `Edit ${type.name}` : 'New type'}
      className="flex flex-col gap-3"
    >
      <label className={label}>
        Name
        <input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          autoComplete="off"
          className={field}
        />
      </label>
      <label className={label}>
        Under
        <select
          name="parentId"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className={field}
        >
          <option value="">Nothing: at the top</option>
          {catalog.types
            .filter((t) => !excluded.has(t.id))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {indented(t)}
              </option>
            ))}
        </select>
      </label>
      <FormButtons
        busy={busy}
        existing={type}
        onCancel={onCancel}
        onRetire={() =>
          void run(
            () => api(path, { method: 'PATCH', body: JSON.stringify({ active: !type!.active }) }),
            type!.active
              ? `${type!.name} is retired. Expenses that have it keep it.`
              : `${type!.name} is back in use.`,
          )
        }
        onDelete={() =>
          void run(() => api(path, { method: 'DELETE' }), `${type!.name} is deleted.`)
        }
      />
      {error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}
