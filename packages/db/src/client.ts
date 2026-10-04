import { isUuid, MEMBER_ROLES, type MemberRole } from '@expensewise/domain';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { connectionConfig } from './connection.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseOptions {
  /**
   * Connections per process. Serverless functions behind Supabase's transaction pooler
   * should use 1–3; the pg default of 10 per instance exhausts the pooler quickly.
   */
  readonly max?: number;
  /** TLS override. Supabase hosts get verified TLS automatically (see connectionConfig). */
  readonly ssl?: pg.PoolConfig['ssl'];
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    ...connectionConfig(connectionString),
    max: options.max,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Refuses to serve tenant data as a role that ignores row-level security. On Supabase the
 * `postgres` role has BYPASSRLS, so a runtime pointed at it would silently switch tenant
 * isolation off. Call once at startup; the API must connect as expensewise_app (ADR-0013).
 */
export async function assertRowSecurityApplies(db: Database): Promise<void> {
  const { rows } = await db.execute<{ role: string; superuser: boolean; bypass: boolean }>(sql`
    select current_user as role, rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`);
  const role = rows[0];
  if (!role || role.superuser || role.bypass) {
    throw new Error(
      `Refusing to serve tenant data as "${role?.role ?? 'unknown'}": this role bypasses ` +
        'row-level security. Connect as expensewise_app.',
    );
  }
}

/**
 * The member a transaction acts for, and their role (ADR-0035). Row-level security then shows
 * a member or approver only their own receipts, expenses, trips and reports, and what hangs
 * off them; owners, finance admins and auditors see everyone's. Everyone changes only their
 * own, and an auditor changes nothing.
 */
export interface MemberScope {
  readonly memberId: string;
  readonly role: MemberRole;
}

export interface OrgOptions {
  /** The signed-in user, for the policies that show a user their own sign-ins. */
  readonly userId?: string;
  /**
   * The member the work is done for. Leave it out for the system's own work, such as a
   * workflow or the release, which sees and changes every member's records in the
   * organization. The API passes the caller's membership for everything a member asks for.
   */
  readonly member?: MemberScope;
}

/**
 * Runs `work` in a transaction bound to one organization. Row-level security reads
 * `app.org_id`, so every query inside sees and writes only that organization's rows; with a
 * `member`, only the rows that member may see and change (ADR-0035). The settings are
 * transaction-local, which is also what makes them safe behind a transaction-mode connection
 * pooler.
 */
export async function withOrg<T>(
  db: Database,
  orgId: string,
  work: (tx: Transaction) => Promise<T>,
  options: OrgOptions = {},
): Promise<T> {
  if (!isUuid(orgId)) throw new Error(`withOrg needs an organization UUID, got "${orgId}"`);
  if (options.member) checkMember(options.member);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    if (options.userId) await setUser(tx, options.userId);
    if (options.member) await setMember(tx, options.member);
    return work(tx);
  });
}

/**
 * Runs `work` for one member of one organization: withOrg() with their membership, so they
 * see and change only what their role allows (ADR-0035).
 */
export function withMember<T>(
  db: Database,
  membership: MemberScope & { readonly orgId: string },
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withOrg(db, membership.orgId, work, {
    member: { memberId: membership.memberId, role: membership.role },
  });
}

/**
 * Moves an open withOrg() transaction to another organization: from here on it sees and
 * writes only `orgId`'s rows, for the system rather than for any one member. Only for one
 * person's change that spans two organizations, such as moving a sign-in out of an empty
 * organization or joining one by an invite.
 */
export async function switchOrg(tx: Transaction, orgId: string): Promise<void> {
  if (!isUuid(orgId)) throw new Error(`switchOrg needs an organization UUID, got "${orgId}"`);
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
  await tx.execute(sql`select set_config('app.member_id', '', true)`);
  await tx.execute(sql`select set_config('app.member_role', '', true)`);
}

function checkMember(member: MemberScope): void {
  if (!isUuid(member.memberId)) {
    throw new Error(`withOrg needs a member UUID, got "${member.memberId}"`);
  }
  if (!(MEMBER_ROLES as readonly string[]).includes(member.role)) {
    throw new Error(`withOrg needs a member role, got "${member.role}"`);
  }
}

async function setMember(tx: Transaction, member: MemberScope): Promise<void> {
  await tx.execute(sql`select set_config('app.member_id', ${member.memberId}, true)`);
  await tx.execute(sql`select set_config('app.member_role', ${member.role}, true)`);
}

/**
 * Whether the database refused a change because it was not the acting member's own
 * (ADR-0035): another member's record, or anything at all for an auditor.
 */
export function isOwnRecordsRefusal(error: unknown): boolean {
  for (let cur: unknown = error; cur instanceof Error; cur = cur.cause) {
    const code = (cur as { code?: unknown }).code;
    if (code === '42501' && cur.message.startsWith('own_records:')) return true;
  }
  return false;
}

/**
 * Runs `work` in a transaction that knows the signed-in user but no organization. Row-level
 * security then shows only that user's own sign-ins and the members they sign in as (policies
 * own_sign_ins and own_memberships), which is how the API finds the caller's organizations. The user id must come from a verified token.
 */
export async function withUser<T>(
  db: Database,
  userId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setUser(tx, userId);
    return work(tx);
  });
}

async function setUser(tx: Transaction, userId: string): Promise<void> {
  if (!userId.trim()) throw new Error('withUser needs a user id');
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}
