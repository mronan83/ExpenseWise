import {
  excludeLine,
  excludePurchase,
  includeLine,
  includePurchase,
  itemizationsOf,
  partsOf,
  reportByCategory,
  splitExpense,
  unsplitExpense,
  type CategorizedExpense,
  type Database,
  type LineChangeResult,
  type PartRecord,
  type SplitRequest,
  type StoredItemization,
} from '@expensewise/db';
import type { Itemization } from '@expensewise/domain';
import { asCaller } from './caller.ts';

/**
 * What the API needs from the database for a receipt's itemized lines and an expense's split
 * (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041). Every change appends its audit event in the same
 * transaction. `seed` is the lines of the reading an expense was filed with, for an expense
 * filed before lines were copied onto it: its first change takes them first.
 */
export interface ItemizedStore {
  /** The lines and parts of these expenses, as the caller may see them. */
  of(
    orgId: string,
    expenseIds: readonly string[],
  ): Promise<{ readonly lines: StoredItemization[]; readonly parts: PartRecord[] }>;
  exclude(
    orgId: string,
    expenseId: string,
    position: number,
    exclusion: { readonly reason: string; readonly note?: string | null },
    actorUserId: string,
    seed: Itemization | null,
  ): Promise<LineChangeResult>;
  include(
    orgId: string,
    expenseId: string,
    position: number,
    actorUserId: string,
    seed: Itemization | null,
  ): Promise<LineChangeResult>;
  /** Leaves a whole purchase on a receipt of several out, by its number (FR-EXP-20). */
  excludePurchase(
    orgId: string,
    expenseId: string,
    purchase: number,
    exclusion: { readonly reason: string; readonly note?: string | null },
    actorUserId: string,
    seed: Itemization | null,
  ): Promise<LineChangeResult>;
  includePurchase(
    orgId: string,
    expenseId: string,
    purchase: number,
    actorUserId: string,
    seed: Itemization | null,
  ): Promise<LineChangeResult>;
  split(
    orgId: string,
    expenseId: string,
    request: SplitRequest,
    actorUserId: string,
    seed: Itemization | null,
  ): Promise<LineChangeResult>;
  unsplit(orgId: string, expenseId: string, actorUserId: string): Promise<LineChangeResult>;
  /** A report's currency and its expenses by category and type; undefined when not visible. */
  byCategory(
    orgId: string,
    reportId: string,
  ): Promise<{ readonly currency: string; readonly expenses: CategorizedExpense[] } | undefined>;
}

/** The store on Postgres, as expensewise_app and as the caller (ADR-0035). */
export function dbItemizedStore(db: Database): ItemizedStore {
  const inOrg = asCaller(db);
  return {
    of: (orgId, expenseIds) =>
      inOrg(orgId, async (tx) => ({
        lines: await itemizationsOf(tx, expenseIds),
        parts: await partsOf(tx, expenseIds),
      })),
    exclude: (orgId, expenseId, position, exclusion, actor, seed) =>
      inOrg(orgId, (tx) => excludeLine(tx, orgId, expenseId, position, exclusion, actor, seed)),
    include: (orgId, expenseId, position, actor, seed) =>
      inOrg(orgId, (tx) => includeLine(tx, orgId, expenseId, position, actor, seed)),
    excludePurchase: (orgId, expenseId, purchase, exclusion, actor, seed) =>
      inOrg(orgId, (tx) => excludePurchase(tx, orgId, expenseId, purchase, exclusion, actor, seed)),
    includePurchase: (orgId, expenseId, purchase, actor, seed) =>
      inOrg(orgId, (tx) => includePurchase(tx, orgId, expenseId, purchase, actor, seed)),
    split: (orgId, expenseId, request, actor, seed) =>
      inOrg(orgId, (tx) => splitExpense(tx, orgId, expenseId, request, actor, seed)),
    unsplit: (orgId, expenseId, actor) =>
      inOrg(orgId, (tx) => unsplitExpense(tx, orgId, expenseId, actor)),
    byCategory: (orgId, reportId) => inOrg(orgId, (tx) => reportByCategory(tx, reportId)),
  };
}
