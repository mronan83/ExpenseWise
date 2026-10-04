'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { useFeatures } from './features';

/** The flag the audit trail ships behind (Q5). */
export const AUDIT_FLAG = 'governance.audit-trail';

export interface AuditActor {
  type: 'user' | 'system';
  id: string | null;
  name: string | null;
  email: string | null;
}

/** One change, as the API returns it: its details exactly as stored and hashed. */
export interface AuditEvent {
  sequence: number;
  occurredAt: string;
  actor: AuditActor;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  hash: string;
  prevHash: string;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface AuditVerification {
  intact: boolean;
  checked: number;
  total: number;
  brokenAt: {
    sequence: number;
    occurredAt: string;
    entityType: string;
    entityId: string;
    action: string;
  } | null;
  checkedAt: string;
}

/** What each kind of record is called on screen. */
export const RECORD_NAMES: Readonly<Record<string, string>> = {
  receipt: 'Receipt',
  expense: 'Expense',
  report: 'Report',
  trip: 'Trip',
  organization: 'Organization',
  feature: 'Feature',
  ai_provider_key: 'AI provider key',
  member_sign_in: 'Sign-in',
  inbound_email: 'Email',
};

const words = (s: string) => s.replace(/[._]+/g, ' ').trim();
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const recordName = (entityType: string) =>
  RECORD_NAMES[entityType] ?? capitalized(words(entityType));

/** "Receipt captured", "Expense trip filed": the record, then what happened to it. */
export function actionLabel(event: Pick<AuditEvent, 'entityType' | 'action'>): string {
  const prefix = `${event.entityType}.`;
  const what = event.action.startsWith(prefix) ? event.action.slice(prefix.length) : event.action;
  return `${recordName(event.entityType)} ${words(what)}`;
}

/** A uuid shortened to its first eight characters; a short id, such as a flag, in full. */
export const shortId = (id: string) => (id.length > 13 ? `${id.slice(0, 8)}…` : id);

/** Who made a change: the member, else the sign-in's id; the app's workflow by its name. */
export function actorLabel(actor: AuditActor): string {
  if (actor.type === 'system') return `ExpenseWise (${actor.id ?? 'the app'})`;
  if (actor.name) return actor.email ? `${actor.name} · ${actor.email}` : actor.name;
  return actor.id ? `Sign-in ${shortId(actor.id)}` : 'Someone';
}

/** A detail's value, compactly: text as it is, anything else as JSON. */
export const detailText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** The trail, narrowed to one record. */
export const trailHref = (entityType: string, entityId: string) =>
  `/settings/audit?${new URLSearchParams({ entityType, entityId }).toString()}`;

let probe: Promise<boolean> | undefined;

/** Whether the caller may read the trail: asked once per page load. */
function mayReadTrail(): Promise<boolean> {
  probe ??= api<AuditPage>('/v1/audit/events?limit=1').then(
    () => true,
    () => false,
  );
  return probe;
}

/**
 * Whether to offer the audit trail: its feature is on, and the caller is an owner, finance
 * admin or auditor. Off until both are known, so nothing shows that can't be opened.
 */
export function useAuditTrail(): boolean {
  const on = useFeatures();
  const flagOn = on(AUDIT_FLAG);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!flagOn) return;
    let live = true;
    void mayReadTrail().then((ok) => {
      if (live) setAllowed(ok);
    });
    return () => {
      live = false;
    };
  }, [flagOn]);
  return flagOn && allowed;
}
