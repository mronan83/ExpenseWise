import { applyPlaceInput, newId, type RouteProblem } from '@expensewise/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { savedPlaces } from './schema.ts';

/** A place a member keeps for a drive's stops, such as Home or Office (FR-CAP-04). */
export interface SavedPlace {
  readonly id: string;
  readonly name: string;
  readonly address: string;
}

const columns = { id: savedPlaces.id, name: savedPlaces.name, address: savedPlaces.address };

/** A member's saved places, by name. Call inside withOrg(). */
export function listSavedPlaces(tx: Transaction, memberId: string): Promise<SavedPlace[]> {
  return tx
    .select(columns)
    .from(savedPlaces)
    .where(eq(savedPlaces.memberId, memberId))
    .orderBy(asc(sql`lower(${savedPlaces.name})`), asc(savedPlaces.id));
}

export type SavePlaceResult =
  | { readonly status: 'saved'; readonly place: SavedPlace }
  | { readonly status: 'unchanged'; readonly place: SavedPlace }
  | { readonly status: 'invalid'; readonly problem: RouteProblem }
  /** The member already keeps a place of that name. */
  | { readonly status: 'taken' }
  | { readonly status: 'missing' };

const entity = (id: string) => ({ entityType: 'saved_place', entityId: id });

/** Whether the member keeps another place by this name, case aside. */
async function nameTaken(tx: Transaction, memberId: string, name: string, except?: string) {
  const rows = await tx
    .select({ id: savedPlaces.id })
    .from(savedPlaces)
    .where(
      and(eq(savedPlaces.memberId, memberId), sql`lower(${savedPlaces.name}) = lower(${name})`),
    );
  return rows.some((r) => r.id !== except);
}

/**
 * Saves a new place for a member, or changes one of theirs, with its audit event. The trail
 * records the place's name and that its address changed, never the address: a home address
 * is the member's own. Call inside withOrg(), as the member.
 */
export async function savePlace(
  tx: Transaction,
  orgId: string,
  memberId: string,
  placeId: string | null,
  input: { readonly name?: string; readonly address?: string },
  actorUserId: string,
): Promise<SavePlaceResult> {
  let current: SavedPlace | undefined;
  if (placeId !== null) {
    [current] = await tx
      .select(columns)
      .from(savedPlaces)
      .where(and(eq(savedPlaces.id, placeId), eq(savedPlaces.memberId, memberId)))
      .for('update');
    if (!current) return { status: 'missing' };
  }
  const applied = applyPlaceInput(current ?? null, input);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { name, address } = applied.value;
  if (current && current.name === name && current.address === address) {
    return { status: 'unchanged', place: current };
  }
  if (await nameTaken(tx, memberId, name, current?.id)) return { status: 'taken' };
  const actor = { type: 'user', id: actorUserId } as const;
  if (!current) {
    const id = newId();
    await tx.insert(savedPlaces).values({ id, orgId, memberId, name, address });
    await appendAuditEvent(tx, orgId, {
      actor,
      ...entity(id),
      action: 'saved_place.added',
      payload: { name },
    });
    return { status: 'saved', place: { id, name, address } };
  }
  await tx
    .update(savedPlaces)
    .set({ name, address, updatedAt: new Date() })
    .where(eq(savedPlaces.id, current.id));
  await appendAuditEvent(tx, orgId, {
    actor,
    ...entity(current.id),
    action: 'saved_place.changed',
    payload: {
      ...(current.name === name ? { name } : { name: { from: current.name, to: name } }),
      addressChanged: current.address !== address,
    },
  });
  return { status: 'saved', place: { id: current.id, name, address } };
}

/** Removes one of a member's places, with its audit event. False when there was none. */
export async function removePlace(
  tx: Transaction,
  orgId: string,
  memberId: string,
  placeId: string,
  actorUserId: string,
): Promise<boolean> {
  const removed = await tx
    .delete(savedPlaces)
    .where(and(eq(savedPlaces.id, placeId), eq(savedPlaces.memberId, memberId)))
    .returning({ name: savedPlaces.name });
  if (removed.length === 0) return false;
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    ...entity(placeId),
    action: 'saved_place.removed',
    payload: { name: removed[0]!.name },
  });
  return true;
}
