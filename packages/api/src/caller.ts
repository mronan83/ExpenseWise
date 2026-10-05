import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assertRowSecurityApplies,
  withOrg,
  type Database,
  type MemberScope,
  type Membership,
  type Transaction,
} from '@expensewise/db';
import type { MiddlewareHandler } from 'hono';
import type { Identity } from './auth.ts';
import { ProblemError } from './problem.ts';
import type { CallerMembership, WorkspaceStore } from './workspace.ts';

/*
 * Who a request acts for, inside its organization (GAP-20, ADR-0035). Each request gets a slot;
 * resolving the caller's membership fills it; and every store that reads or writes members'
 * records runs its transaction as that member, so row-level security shows them only what
 * their role allows. Background work never runs in a request and acts for the system.
 */

interface CallerSlot {
  member?: Membership;
  /** Who the verified token says is calling, once `requireIdentity` has checked it. */
  identity?: Identity;
  /** A request the code screen needs, which a session that skipped the code may make (#85). */
  beforeTheCode?: boolean;
}

const slots = new AsyncLocalStorage<CallerSlot>();

/** Gives each request an empty slot for the caller's membership. Registered before any route. */
export const callerScope: MiddlewareHandler = (_c, next) => slots.run({}, next);

/** Records the membership the current request acts for. */
export function actAs(member: Membership): void {
  const slot = slots.getStore();
  if (slot) slot.member = member;
}

/** Records who the verified token of the current request says is calling. */
export function recordIdentity(identity: Identity): void {
  const slot = slots.getStore();
  if (slot) slot.identity = identity;
}

/** Who the current request's verified token says is calling, once it has been checked. */
export function requestIdentity(): Identity | undefined {
  return slots.getStore()?.identity;
}

/** Marks the current request as one the code screen needs (#85, ADR-0044). */
export function markBeforeTheCode(): void {
  const slot = slots.getStore();
  if (slot) slot.beforeTheCode = true;
}

/** Whether the current request is one the code screen needs. */
export function isBeforeTheCode(): boolean {
  return slots.getStore()?.beforeTheCode === true;
}

/**
 * What runs as a request resolves its caller, before anything of the organization is read or
 * changed: the second factor's check (#85). Throwing refuses the request.
 */
export type AdmitCaller = (caller: CallerMembership, userId: string) => Promise<void>;

/** The member the current request acts for in `orgId`, if it has resolved one there. */
export function callerIn(orgId: string): MemberScope | undefined {
  const member = slots.getStore()?.member;
  return member && member.orgId === orgId
    ? { memberId: member.memberId, role: member.role }
    : undefined;
}

/**
 * The workspace store, with every membership it finds for a caller first admitted, then
 * recorded as who the request acts for. Every route resolves its caller this way, so none can
 * forget to, and none reads or changes its organization's data before the caller is admitted.
 */
export function recordingCaller(
  workspace: WorkspaceStore,
  admit: AdmitCaller = () => Promise.resolve(),
): WorkspaceStore {
  return new Proxy(workspace, {
    get(target, property) {
      if (property === 'findMembership') {
        return async (userId: string) => {
          const membership = await target.findMembership(userId);
          if (membership) {
            await admit(membership, userId);
            actAs(membership);
          }
          return membership;
        };
      }
      if (property === 'ensureOrganization') {
        // The organization a sign-in opens with, made on its first: admitted the same way.
        return async (owner: Parameters<WorkspaceStore['ensureOrganization']>[0]) => {
          const result = await target.ensureOrganization(owner);
          await admit(result.membership, owner.userId);
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * The answer when the database refuses a change that isn't the caller's own (ADR-0035): another
 * member's record, which an owner, finance admin or auditor may open but not change, or
 * anything at all for an auditor.
 */
export function notYours(): ProblemError {
  return new ProblemError(403, 'not-yours', 'You can change only your own records', {
    code: 'not_yours',
    detail:
      'Owners, finance admins and auditors can open everyone’s receipts, expenses and trips; ' +
      'each person changes only their own, and an auditor changes nothing.',
  });
}

/** A request for members' records made before the caller's membership was resolved. */
export class NoCallerError extends Error {
  constructor(orgId: string) {
    super(`No member resolved for organization ${orgId}: members' records need one`);
    this.name = 'NoCallerError';
  }
}

/**
 * Runs a store's work as the request's caller (ADR-0035). It checks the database role once,
 * before first use, and refuses to run without a caller in that organization rather than act
 * for the system.
 */
export function asCaller(
  db: Database,
): <T>(orgId: string, work: (tx: Transaction) => Promise<T>) => Promise<T> {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return async (orgId, work) => {
    await safe();
    const member = callerIn(orgId);
    if (!member) throw new NoCallerError(orgId);
    return withOrg(db, orgId, work, { member });
  };
}
