import {
  assertCurrency,
  checkChoice,
  checkExclusion,
  claimWithout,
  isExpenseEditable,
  lineTools,
  money,
  partsByAmount,
  partsByLine,
  type ChoiceProblem,
  type ConversionRecord,
  type ExclusionProblem,
  type ExclusionReason,
  type ExpenseSource,
  type ExpenseStatus,
  type Itemization,
  type LineAssignment,
  type LineToolsProblem,
  type Part,
  type ReadLine,
  type SplitProblem,
  type TypedPart,
} from '@expensewise/domain';
import { and, asc, eq, inArray, isNotNull, not, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { listCatalog } from './categories.ts';
import { conversionRecord, onItsReport, recordColumns, tripOf } from './conversions.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import {
  categories,
  expenseConversions,
  expenseItemizations,
  expenseLines,
  expenseParts,
  expenses,
  expenseTypes,
  reports,
} from './schema.ts';

/*
 * A receipt's itemized lines on its expense, and the parts a split expense is made of
 * (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041). The arithmetic is the domain's; this keeps it,
 * with each change audited in the same transaction.
 */

/** One line as its expense keeps it, with whether it is excluded and the part it was given. */
export interface StoredLine extends ReadLine {
  /** Its number on the receipt, from 1. */
  readonly position: number;
  readonly excluded: {
    readonly reason: ExclusionReason;
    readonly note: string | null;
    readonly at: Date;
  } | null;
  /** The category and type a person gave it in a split by line; null: the expense's own. */
  readonly categoryId: string | null;
  readonly typeId: string | null;
}

/** An expense's copy of its receipt's lines. */
export interface StoredItemization extends Itemization {
  readonly expenseId: string;
  readonly lines: readonly StoredLine[];
}

/** A part of a split expense, with its category's and type's names. */
export interface PartRecord {
  readonly expenseId: string;
  readonly position: number;
  readonly basis: 'lines' | 'amounts';
  /** Null for the lines left with the expense's own category and type. */
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly typeId: string | null;
  readonly type: string | null;
  readonly amountMinor: number;
  readonly currency: string;
}

/** The lines these expenses keep, in order. Call inside withOrg(). */
export async function itemizationsOf(
  tx: Transaction,
  expenseIds: readonly string[],
): Promise<StoredItemization[]> {
  if (expenseIds.length === 0) return [];
  const heads = await tx
    .select()
    .from(expenseItemizations)
    .where(inArray(expenseItemizations.expenseId, [...expenseIds]));
  if (heads.length === 0) return [];
  const rows = await tx
    .select()
    .from(expenseLines)
    .where(
      inArray(
        expenseLines.expenseId,
        heads.map((h) => h.expenseId),
      ),
    )
    .orderBy(asc(expenseLines.expenseId), asc(expenseLines.position));
  return heads.map((h) => {
    const currency = assertCurrency(h.currency);
    const amount = (minor: number | null) => (minor === null ? null : money(minor, currency));
    return {
      expenseId: h.expenseId,
      currency,
      total: amount(h.totalMinor),
      subtotal: amount(h.subtotalMinor),
      lines: rows
        .filter((r) => r.expenseId === h.expenseId)
        .map((r) => ({
          position: r.position,
          kind: r.kind,
          description: r.description,
          quantity: r.quantity,
          amount: money(r.amountMinor, currency),
          excluded:
            r.excludedReason && r.excludedAt
              ? { reason: r.excludedReason, note: r.excludedNote, at: r.excludedAt }
              : null,
          categoryId: r.categoryId,
          typeId: r.typeId,
        })),
    };
  });
}

/** The parts these expenses are split into, in order, with names. Call inside withOrg(). */
export async function partsOf(
  tx: Transaction,
  expenseIds: readonly string[],
): Promise<PartRecord[]> {
  if (expenseIds.length === 0) return [];
  return tx
    .select({
      expenseId: expenseParts.expenseId,
      position: expenseParts.position,
      basis: expenseParts.basis,
      categoryId: expenseParts.categoryId,
      category: categories.name,
      typeId: expenseParts.typeId,
      type: expenseTypes.name,
      amountMinor: expenseParts.amountMinor,
      currency: expenseParts.currency,
    })
    .from(expenseParts)
    .leftJoin(
      categories,
      and(eq(categories.orgId, expenseParts.orgId), eq(categories.id, expenseParts.categoryId)),
    )
    .leftJoin(
      expenseTypes,
      and(eq(expenseTypes.orgId, expenseParts.orgId), eq(expenseTypes.id, expenseParts.typeId)),
    )
    .where(inArray(expenseParts.expenseId, [...expenseIds]))
    .orderBy(asc(expenseParts.expenseId), asc(expenseParts.position));
}

const sameLines = (a: StoredItemization | undefined, b: Itemization | null) => {
  if (!a || !b) return !a && !b;
  const minor = (m: { amountMinor: number } | null) => m?.amountMinor ?? null;
  return (
    a.currency === b.currency &&
    minor(a.total) === minor(b.total) &&
    minor(a.subtotal) === minor(b.subtotal) &&
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => {
      const o = b.lines[i];
      return (
        o !== undefined &&
        l.kind === o.kind &&
        l.description === o.description &&
        l.quantity === o.quantity &&
        l.amount.amountMinor === o.amount.amountMinor
      );
    })
  );
};

async function insertLines(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  lines: Itemization,
): Promise<void> {
  await tx.insert(expenseItemizations).values({
    orgId,
    expenseId,
    currency: lines.currency,
    totalMinor: lines.total?.amountMinor ?? null,
    subtotalMinor: lines.subtotal?.amountMinor ?? null,
  });
  if (lines.lines.length === 0) return;
  await tx.insert(expenseLines).values(
    lines.lines.map((l, i) => ({
      orgId,
      expenseId,
      position: i + 1,
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      amountMinor: l.amount.amountMinor,
      currency: lines.currency,
    })),
  );
}

/**
 * Copies a reading's lines onto its expense, in place of those it had, or takes them away when
 * the reading has none (ADR-0041). Changes nothing when they are the same. The caller decides
 * whether the expense still follows its receipt. Returns whether anything changed. Call inside
 * withOrg(), in the transaction that files the reading.
 */
export async function copyReadLines(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  lines: Itemization | null,
  actor: AuditEntry['actor'],
): Promise<boolean> {
  const [current] = await itemizationsOf(tx, [expenseId]);
  if (sameLines(current, lines)) return false;
  // Its lines go with it.
  await tx.delete(expenseItemizations).where(eq(expenseItemizations.expenseId, expenseId));
  if (lines) await insertLines(tx, orgId, expenseId, lines);
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.lines_read',
    payload: { lines: lines?.lines.length ?? 0, previous: current?.lines.length ?? 0 },
  });
  return true;
}

/** Whether an expense's claim is made of its lines or parts: a line excluded, or a split. */
export async function claimFromLines(tx: Transaction, expenseId: string): Promise<boolean> {
  const [excluded] = await tx
    .select({ id: expenseLines.id })
    .from(expenseLines)
    .where(and(eq(expenseLines.expenseId, expenseId), isNotNull(expenseLines.excludedReason)))
    .limit(1);
  if (excluded) return true;
  const [part] = await tx
    .select({ id: expenseParts.id })
    .from(expenseParts)
    .where(eq(expenseParts.expenseId, expenseId))
    .limit(1);
  return part !== undefined;
}

/**
 * Lets go of what made an expense's claim of its lines: every exclusion and split, after its
 * amount or currency was taken from elsewhere, as a merge does. Audited when anything changed.
 */
export async function releaseLines(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  actor: AuditEntry['actor'],
): Promise<void> {
  if (!(await claimFromLines(tx, expenseId))) {
    const [given] = await tx
      .select({ id: expenseLines.id })
      .from(expenseLines)
      .where(and(eq(expenseLines.expenseId, expenseId), isNotNull(expenseLines.categoryId)))
      .limit(1);
    if (!given) return;
  }
  await tx
    .update(expenseLines)
    .set({
      excludedReason: null,
      excludedNote: null,
      excludedAt: null,
      categoryId: null,
      typeId: null,
      updatedAt: new Date(),
    })
    .where(eq(expenseLines.expenseId, expenseId));
  await tx.delete(expenseParts).where(eq(expenseParts.expenseId, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.lines_released',
  });
}

/** How a change to an expense's lines or split ended. */
export type LineChangeResult =
  | { readonly status: 'changed' }
  /** It was already so. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** Being read, or submitted or later: its claim can't change (FR-EXP-09). */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus }
  /** Its receipt has no itemized lines. */
  | { readonly status: 'not_itemized' }
  /** Its lines don't make up its claim, so they can't be excluded or split by line. */
  | { readonly status: 'not_usable'; readonly problem: LineToolsProblem }
  /** It has no amount yet to split. */
  | { readonly status: 'no_claim' }
  /** A drive: its amount is miles × its rate, changed as mileage, so it isn't split (ADR-0038). */
  | { readonly status: 'mileage' }
  /** Split by amount: its lines can't change what it claims until that split goes. */
  | { readonly status: 'split_by_amount' }
  | {
      readonly status: 'invalid';
      readonly problem: SplitProblem | ExclusionProblem | ChoiceProblem;
      /** The part, from 0, a split by amount was refused for. */
      readonly index?: number;
    };

interface Opened {
  readonly expense: {
    readonly status: ExpenseStatus;
    readonly source: ExpenseSource;
    readonly currency: string | null;
    readonly amountMinor: number | null;
  };
  readonly lines: StoredItemization | undefined;
  readonly parts: readonly PartRecord[];
}

/**
 * The expense, locked, with its lines and parts, once it is open to a person's change. Without
 * lines, it takes `seed`, its receipt's reading's lines, first: an expense filed before lines
 * were copied (ADR-0041).
 */
async function open(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  actorUserId: string,
  seed: Itemization | null | undefined,
): Promise<Opened | LineChangeResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      status: expenses.status,
      source: expenses.source,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (!isExpenseEditable(expense.status))
    return { status: 'not_editable', current: expense.status };
  let [lines] = await itemizationsOf(tx, [expenseId]);
  if (!lines && seed) {
    await copyReadLines(tx, orgId, expenseId, seed, { type: 'user', id: actorUserId });
    [lines] = await itemizationsOf(tx, [expenseId]);
  }
  return { expense, lines, parts: await partsOf(tx, [expenseId]) };
}

const isResult = (x: Opened | LineChangeResult): x is LineChangeResult => 'status' in x;

const excludedOf = (lines: StoredItemization) =>
  new Set(lines.lines.filter((l) => l.excluded).map((l) => l.position));
const assignmentsOf = (lines: StoredItemization): LineAssignment[] =>
  lines.lines.flatMap((l) =>
    l.categoryId && l.typeId
      ? [{ position: l.position, categoryId: l.categoryId, typeId: l.typeId }]
      : [],
  );

async function replaceParts(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  basis: 'lines' | 'amounts',
  parts: readonly Part[],
): Promise<void> {
  await tx.delete(expenseParts).where(eq(expenseParts.expenseId, expenseId));
  if (parts.length === 0) return;
  await tx.insert(expenseParts).values(
    parts.map((p, i) => ({
      orgId,
      expenseId,
      position: i + 1,
      basis,
      categoryId: p.categoryId,
      typeId: p.typeId,
      amountMinor: p.amount.amountMinor,
      currency: p.amount.currency,
    })),
  );
}

/** Sets what the expense claims, as a person's edit, and reopens a closed report it is on. */
async function claim(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  amountMinor: number,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await tx
    .update(expenses)
    .set({ amountMinor, editedAt: now, updatedAt: now })
    .where(eq(expenses.id, expenseId));
  // A new amount converts again at the rate it was converted at (ADR-0034).
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    { type: 'user', id: actorUserId },
    reason,
  );
}

/** Excludes a line or includes it again, working out the claim and any split by line again. */
async function setExcluded(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  position: number,
  exclusion: { readonly reason: ExclusionReason; readonly note: string | null } | null,
  actorUserId: string,
  seed: Itemization | null | undefined,
): Promise<LineChangeResult> {
  const opened = await open(tx, orgId, expenseId, actorUserId, seed);
  if (isResult(opened)) return opened;
  const { expense, lines, parts } = opened;
  if (!lines) return { status: 'not_itemized' };
  const excluded = excludedOf(lines);
  const usable = lineTools(lines, excluded, expense);
  if (!usable.ok) return { status: 'not_usable', problem: usable.error };
  const line = lines.lines.find((l) => l.position === position);
  if (!line) return { status: 'invalid', problem: 'no_such_line' };
  const was = line.excluded;
  if (exclusion === null ? !was : was?.reason === exclusion.reason && was.note === exclusion.note) {
    return { status: 'unchanged' };
  }
  const next = new Set(excluded);
  if (exclusion) next.add(position);
  else next.delete(position);
  const after = claimWithout(lines, next);
  if (!after.ok) return { status: 'invalid', problem: after.error };
  const byLine = parts.length > 0 && parts.every((p) => p.basis === 'lines');
  if (parts.length > 0 && !byLine && Boolean(was) !== Boolean(exclusion)) {
    return { status: 'split_by_amount' };
  }
  const assigned = assignmentsOf(lines);
  const reparted = partsByLine(lines, next, assigned, false);
  if (assigned.length > 0 && !reparted.ok) return { status: 'invalid', problem: reparted.error };

  const now = new Date();
  await tx
    .update(expenseLines)
    .set(
      exclusion
        ? {
            excludedReason: exclusion.reason,
            excludedNote: exclusion.note,
            excludedAt: now,
            updatedAt: now,
          }
        : { excludedReason: null, excludedNote: null, excludedAt: null, updatedAt: now },
    )
    .where(and(eq(expenseLines.expenseId, expenseId), eq(expenseLines.position, position)));
  if (assigned.length > 0 && reparted.ok) {
    await replaceParts(tx, orgId, expenseId, 'lines', reparted.value);
  }
  const claimed = after.value.claimed.amountMinor;
  const lineClaim = claimWithout(lines, new Set([position]));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'expense',
    entityId: expenseId,
    action: exclusion ? 'expense.line_excluded' : 'expense.line_included',
    payload: {
      position,
      line: line.description,
      ...(exclusion ? { reason: exclusion.reason, note: exclusion.note } : {}),
      ...(was && exclusion ? { previous: { reason: was.reason, note: was.note } } : {}),
      takesOff: lineClaim.ok ? lineClaim.value.excluded.amountMinor : null,
      claimed,
      previousClaim: expense.amountMinor,
    },
  });
  if (claimed !== expense.amountMinor) {
    await claim(
      tx,
      orgId,
      expenseId,
      claimed,
      actorUserId,
      exclusion ? 'a line on an expense was excluded' : 'a line on an expense was included again',
    );
  } else {
    await tx
      .update(expenses)
      .set({ editedAt: now, updatedAt: now })
      .where(eq(expenses.id, expenseId));
  }
  return { status: 'changed' };
}

/**
 * Leaves a line of an expense's receipt out of its claim, with a reason picked from the list
 * and a note that other needs (FR-EXP-16, Q40); a line already excluded takes the new reason.
 * The claim drops by the line and its share of the tax, tip and fees (Q39), and a split by line
 * is worked out again. Only while the expense is open to edits, and its lines make up its
 * claim. Call inside withOrg(), as the caller.
 */
export async function excludeLine(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  position: number,
  exclusion: { readonly reason: string; readonly note?: string | null },
  actorUserId: string,
  seed?: Itemization | null,
): Promise<LineChangeResult> {
  const checked = checkExclusion(exclusion.reason, exclusion.note);
  if (!checked.ok) return { status: 'invalid', problem: checked.error };
  return setExcluded(tx, orgId, expenseId, position, checked.value, actorUserId, seed);
}

/** Includes an excluded line in the claim again, before submission (FR-EXP-16). */
export function includeLine(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  position: number,
  actorUserId: string,
  seed?: Itemization | null,
): Promise<LineChangeResult> {
  return setExcluded(tx, orgId, expenseId, position, null, actorUserId, seed);
}

/** A split as a person asks for it (Q38): by giving lines categories and types, or by amounts. */
export type SplitRequest =
  | { readonly basis: 'lines'; readonly lines: readonly LineAssignment[] }
  | { readonly basis: 'amounts'; readonly parts: readonly TypedPart[] };

/**
 * Splits an expense into parts, each with its own category and type (FR-EXP-15, Q37): one
 * expense with one receipt. By line, where its lines make up its claim; by amount, typed parts
 * that add up to the claim exactly, or the split is refused. A new split replaces the one
 * before. Audited, and the expense no longer follows its receipt. Call inside withOrg(), as
 * the caller.
 */
export async function splitExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  request: SplitRequest,
  actorUserId: string,
  seed?: Itemization | null,
): Promise<LineChangeResult> {
  const opened = await open(tx, orgId, expenseId, actorUserId, seed);
  if (isResult(opened)) return opened;
  const { expense, lines } = opened;
  if (expense.source === 'mileage') return { status: 'mileage' };
  if (expense.amountMinor === null || expense.currency === null) return { status: 'no_claim' };
  const catalog = await listCatalog(tx);
  const choices = request.basis === 'lines' ? request.lines : request.parts;
  for (const [index, choice] of choices.entries()) {
    const checked = checkChoice(catalog, choice.categoryId, choice.typeId);
    if (!checked.ok) return { status: 'invalid', problem: checked.error, index };
  }

  let parts: Part[];
  if (request.basis === 'lines') {
    if (!lines) return { status: 'not_itemized' };
    const excluded = excludedOf(lines);
    const usable = lineTools(lines, excluded, expense);
    if (!usable.ok) return { status: 'not_usable', problem: usable.error };
    const made = partsByLine(lines, excluded, request.lines);
    if (!made.ok) return { status: 'invalid', problem: made.error };
    parts = made.value;
  } else {
    const made = partsByAmount(money(expense.amountMinor, expense.currency), request.parts);
    if (!made.ok) return { status: 'invalid', ...made.error };
    parts = made.value;
  }

  const now = new Date();
  await tx
    .update(expenseLines)
    .set({ categoryId: null, typeId: null, updatedAt: now })
    .where(and(eq(expenseLines.expenseId, expenseId), isNotNull(expenseLines.categoryId)));
  if (request.basis === 'lines') {
    for (const a of request.lines) {
      await tx
        .update(expenseLines)
        .set({ categoryId: a.categoryId, typeId: a.typeId, updatedAt: now })
        .where(and(eq(expenseLines.expenseId, expenseId), eq(expenseLines.position, a.position)));
    }
  }
  await replaceParts(tx, orgId, expenseId, request.basis, parts);
  await tx
    .update(expenses)
    .set({ editedAt: now, updatedAt: now })
    .where(eq(expenses.id, expenseId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.split',
    payload: {
      basis: request.basis,
      parts: parts.map((p) => ({
        categoryId: p.categoryId,
        typeId: p.typeId,
        amountMinor: p.amount.amountMinor,
        lines: p.positions,
      })),
      previous: opened.parts.length,
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'an expense on it was split',
  );
  return { status: 'changed' };
}

/** Takes a split away: the expense is one part again, with its own category and type. */
export async function unsplitExpense(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  actorUserId: string,
): Promise<LineChangeResult> {
  const opened = await open(tx, orgId, expenseId, actorUserId, undefined);
  if (isResult(opened)) return opened;
  const given = opened.lines ? assignmentsOf(opened.lines) : [];
  if (opened.parts.length === 0 && given.length === 0) return { status: 'unchanged' };
  const now = new Date();
  await tx
    .update(expenseLines)
    .set({ categoryId: null, typeId: null, updatedAt: now })
    .where(and(eq(expenseLines.expenseId, expenseId), isNotNull(expenseLines.categoryId)));
  await tx.delete(expenseParts).where(eq(expenseParts.expenseId, expenseId));
  await tx.update(expenses).set({ updatedAt: now }).where(eq(expenses.id, expenseId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.split_removed',
    payload: { parts: opened.parts.length },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'a split on it was removed',
  );
  return { status: 'changed' };
}

/** An expense on a report as its totals by category and type count it. */
export interface CategorizedExpense {
  readonly expenseId: string;
  readonly reportId: string;
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly typeId: string | null;
  readonly type: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly purchaseDate: string | null;
  readonly conversion: ConversionRecord | null;
  /** Its parts, when it is split; a part with no category is the expense's own. */
  readonly parts: readonly PartRecord[];
}

/**
 * Every expense on these reports, through a trip or as a local expense, with its category,
 * type, parts and conversion, for the report's totals by category and type (FR-EXP-15). A
 * possible duplicate is left out, as from every total. Call inside withOrg().
 */
export async function reportCategories(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<CategorizedExpense[]> {
  if (reportIds.length === 0) return [];
  const rows = await tx
    .select({
      expenseId: expenses.id,
      reportId: reports.id,
      categoryId: expenses.categoryId,
      category: categories.name,
      typeId: expenses.typeId,
      type: expenseTypes.name,
      amount: expenses.amountMinor,
      expenseCurrency: expenses.currency,
      transactionDate: expenses.transactionDate,
      ...recordColumns,
    })
    .from(expenses)
    .leftJoin(tripOf, and(eq(tripOf.orgId, expenses.orgId), eq(tripOf.id, expenses.tripId)))
    .innerJoin(reports, onItsReport())
    .leftJoin(
      categories,
      and(eq(categories.orgId, expenses.orgId), eq(categories.id, expenses.categoryId)),
    )
    .leftJoin(
      expenseTypes,
      and(eq(expenseTypes.orgId, expenses.orgId), eq(expenseTypes.id, expenses.typeId)),
    )
    .leftJoin(
      expenseConversions,
      and(
        eq(expenseConversions.orgId, expenses.orgId),
        eq(expenseConversions.expenseId, expenses.id),
      ),
    )
    .where(
      and(
        inArray(reports.id, [...reportIds]),
        isNotNull(expenses.amountMinor),
        isNotNull(expenses.currency),
        not(heldAsDuplicate(expenses.id)),
      ),
    )
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.id);
  const parts = await partsOf(
    tx,
    rows.map((r) => r.expenseId),
  );
  return rows.map((r) => ({
    expenseId: r.expenseId,
    reportId: r.reportId,
    categoryId: r.categoryId,
    category: r.category,
    typeId: r.typeId,
    type: r.type,
    amountMinor: r.amount!,
    currency: r.expenseCurrency!,
    purchaseDate: r.transactionDate,
    conversion: conversionRecord(r),
    parts: parts.filter((p) => p.expenseId === r.expenseId),
  }));
}

/**
 * A report's reimbursement currency and every expense on it by category and type, or
 * undefined when there is no such report the caller may see. Call inside withOrg().
 */
export async function reportByCategory(
  tx: Transaction,
  reportId: string,
): Promise<{ readonly currency: string; readonly expenses: CategorizedExpense[] } | undefined> {
  const [report] = await tx
    .select({ currency: reports.currency })
    .from(reports)
    .where(eq(reports.id, reportId));
  if (!report) return undefined;
  return { currency: report.currency, expenses: await reportCategories(tx, [reportId]) };
}
