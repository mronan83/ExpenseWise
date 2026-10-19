'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../lib/api';
import {
  ROUTE_ADDRESS_MAX,
  SUGGEST_MIN_CHARS,
  SUGGEST_WAIT_MS,
  suggestionProblem,
  typedStop,
  type PlaceSuggestionList,
  type RecentPlace,
  type SavedPlace,
  type StopDraft,
} from '../../lib/route-mileage';

/** One choice in a stop's list: what it shows, where it came from, and the stop it makes. */
interface Choice {
  key: string;
  name: string;
  detail: string;
  /** "Saved place" or "Driven before"; none for a place OpenRouteService suggests. */
  tag: string | null;
  stop: StopDraft;
}

/** Most of a person's own places shown for what is typed, of each kind. */
const MATCHED = 3;
/** Most of a person's own places shown, of each kind, before anything is typed. */
const OPENED = 5;

const has = (text: string, ...fields: string[]) =>
  fields.some((f) => f.toLowerCase().includes(text.toLowerCase()));

/** "1520 Harney St" above "Omaha, NE": an address's first part, then the rest. */
function split(address: string): { name: string; detail: string } {
  const at = address.indexOf(', ');
  return at < 0
    ? { name: address, detail: '' }
    : { name: address.slice(0, at), detail: address.slice(at + 2) };
}

/** What a stop can be filled with: the person's saved and recent places, then those suggested. */
function choicesFor(
  text: string,
  saved: readonly SavedPlace[],
  recent: readonly RecentPlace[],
  answer: PlaceSuggestionList | undefined,
): Choice[] {
  const typed = text.trim();
  const ownSaved =
    typed === ''
      ? saved.slice(0, OPENED)
      : saved.filter((p) => has(typed, p.name, p.address)).slice(0, MATCHED);
  // A place driven to that is also a saved place shows once, by its saved name.
  const savedAt = new Set(saved.map((p) => p.address.toLowerCase()));
  const driven = recent.filter((p) => !savedAt.has(p.address.toLowerCase()));
  const ownRecent =
    typed === ''
      ? driven.slice(0, OPENED)
      : driven.filter((p) => has(typed, p.address, p.label)).slice(0, MATCHED);
  const known = new Set([...savedAt, ...ownRecent.map((p) => p.address.toLowerCase())]);
  return [
    // A saved place's address is copied onto the stop and measured as typed (Q32).
    ...ownSaved.map((p) => ({
      key: `saved-${p.id}`,
      name: p.name,
      detail: p.address,
      tag: 'Saved place',
      stop: typedStop(p.address),
    })),
    // A place driven to before is measured from where it was found then (Q53).
    ...ownRecent.map((p) => ({
      key: `recent-${p.address}`,
      ...split(p.address),
      tag: 'Driven before',
      stop: p.pick
        ? {
            address: p.address,
            pick: p.pick,
            place: { label: p.label, longitude: p.longitude, latitude: p.latitude },
          }
        : typedStop(p.address),
    })),
    ...(answer?.places ?? [])
      .filter((p) => !known.has(p.address.toLowerCase()))
      .map((p) => ({
        key: `suggested-${p.pick}`,
        name: p.name,
        detail: p.detail,
        tag: null,
        stop: {
          address: p.address,
          pick: p.pick,
          place: { label: p.label, longitude: p.longitude, latitude: p.latitude },
        },
      })),
  ];
}

/**
 * A stop's address, with places to pick as it is typed (FR-CAP-14, ADR-0052): the person's
 * saved places and places they have driven to, matched on the phone with nothing sent, then
 * landmarks, businesses and addresses OpenRouteService suggests once typing pauses, near
 * `near` when given (Q54). A place picked is measured from exactly there (Q53); typing over it
 * makes it a stop typed again. A combobox: arrows move through the list, Enter picks, Escape
 * closes it.
 */
export function PlaceField({
  name,
  label,
  value,
  onChange,
  placeholder,
  saved,
  recent,
  near,
}: {
  name: string;
  label: string;
  value: StopDraft;
  onChange: (stop: StopDraft) => void;
  placeholder: string;
  saved: readonly SavedPlace[];
  recent: readonly RecentPlace[];
  /** A place picked earlier in the drive, to rank suggestions near it. */
  near: { longitude: number; latitude: number } | null;
}) {
  const id = useId();
  const listId = `${id}-places`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, PlaceSuggestionList>>({});
  // The texts asked about already, so each is asked once, however often the field renders.
  const asked = useRef(new Set<string>());
  const text = value.address.trim().replace(/\s+/g, ' ');
  const key = text.toLowerCase();
  const lookUp = open && value.pick === null && text.length >= SUGGEST_MIN_CHARS;
  const nearLongitude = near?.longitude ?? null;
  const nearLatitude = near?.latitude ?? null;

  // Once typing pauses, from SUGGEST_MIN_CHARS characters, and once for each text typed.
  useEffect(() => {
    if (!lookUp || answers[key] || asked.current.has(key)) return;
    const timer = setTimeout(() => {
      asked.current.add(key);
      const near =
        nearLongitude === null || nearLatitude === null
          ? null
          : { longitude: nearLongitude, latitude: nearLatitude };
      void api<PlaceSuggestionList>('/v1/mileage/place-suggestions', {
        method: 'POST',
        body: JSON.stringify({ text, near }),
      }).then(
        (list) => setAnswers((all) => ({ ...all, [key]: list })),
        // Without suggestions the address is typed, as it always could be.
        () =>
          setAnswers((all) => ({
            ...all,
            [key]: { places: [], problem: 'unavailable', attribution: '' },
          })),
      );
    }, SUGGEST_WAIT_MS);
    return () => clearTimeout(timer);
  }, [lookUp, answers, key, text, nearLongitude, nearLatitude]);

  const answer = lookUp ? answers[key] : undefined;
  const choices = open && value.pick === null ? choicesFor(text, saved, recent, answer) : [];
  const looking = lookUp && answer === undefined;
  const shown = choices.length > 0;
  const current = active < choices.length ? active : -1;
  const suggested = (answer?.places.length ?? 0) > 0;

  const pick = (choice: Choice) => {
    onChange(choice.stop);
    setOpen(false);
    setActive(-1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive(Math.min(current + 1, choices.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && shown && current >= 0) {
      event.preventDefault();
      pick(choices[current]!);
    } else if (event.key === 'Escape' && shown) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const status = looking
    ? 'Looking up places…'
    : shown
      ? `${choices.length} ${choices.length === 1 ? 'place' : 'places'} to pick from`
      : '';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        name={name}
        required
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && current >= 0 ? `${listId}-${current}` : undefined}
        maxLength={ROUTE_ADDRESS_MAX}
        autoComplete="off"
        placeholder={placeholder}
        value={value.address}
        onChange={(e) => {
          // Typed over, a picked place is a stop typed again.
          onChange(typedStop(e.target.value));
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="w-full min-w-0 rounded-lg border border-rule bg-paper px-3 py-2 text-base text-ink"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={`Places for ${label.toLowerCase()}`}
        hidden={!shown}
        // Picking keeps the field focused, so the list doesn't close before the pick lands.
        onMouseDown={(e) => e.preventDefault()}
        className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-rule bg-paper"
      >
        {choices.map((choice, i) => (
          <li
            key={choice.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === current}
            onClick={() => pick(choice)}
            className={`flex min-w-0 cursor-pointer flex-col gap-0.5 border-b border-rule px-3 py-2 last:border-b-0 ${
              i === current ? 'bg-sheet outline-2 -outline-offset-2 outline-carbon' : ''
            }`}
          >
            {/* Spaces between the parts, so a screen reader reads them apart. */}
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold break-words text-ink">{choice.name}</span>{' '}
              {choice.tag ? <span className="text-xs text-ink-2">{choice.tag}</span> : null}
            </span>{' '}
            {choice.detail ? (
              <span className="text-xs break-words text-ink-2">{choice.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {shown && suggested && answer ? (
        <p className="text-xs text-ink-2">{answer.attribution}</p>
      ) : null}
      <p role="status" className="sr-only">
        {status}
      </p>
      {value.place && value.pick ? (
        <p className="text-xs text-ink-2">Picked, so it is measured from exactly this place.</p>
      ) : null}
      {answer?.problem && open ? (
        <p className="text-xs text-ink-2">{suggestionProblem(answer.problem)}</p>
      ) : null}
    </div>
  );
}
