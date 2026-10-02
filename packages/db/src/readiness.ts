import pg from 'pg';
import { connectionConfig } from './connection.ts';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface ReadinessCheck {
  readonly status: CheckStatus;
  /** One of a fixed set of messages. Never a raw driver error or connection detail. */
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: {
    readonly database: ReadinessCheck;
    readonly role: ReadinessCheck;
    readonly tls: ReadinessCheck;
    readonly tenantIsolation: ReadinessCheck;
  };
}

export interface ReadinessProbeOptions {
  /** Give up on the database after this long. */
  readonly timeoutMs?: number;
  /** Reuse a report this long, so polling the endpoint can't load the database. */
  readonly cacheMs?: number;
  readonly now?: () => number;
  /** Where raw errors go. They never reach the report. */
  readonly log?: (message: string, error: unknown) => void;
}

const RUNTIME_ROLE = 'expensewise_app';
/** Schema v1 has 13 tenant tables (ai_provider_keys since 0004); fewer means migrations have not run. */
const MIN_TENANT_TABLES = 14;
/** The one tenant table that deliberately does not force RLS (migration 0001). */
const UNFORCED_TABLES = new Set(['outbox_events']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NEEDS_DATABASE: ReadinessCheck = { status: 'skip', detail: 'needs a database connection' };

/**
 * Answers "can this deployment safely serve tenant data?" by connecting with the runtime
 * connection string and checking the role, TLS and row-level security that tenant isolation
 * depends on. The returned function never throws; a failed check reads as not ready.
 */
export function createReadinessProbe(
  connectionString: string | undefined,
  options: ReadinessProbeOptions = {},
): () => Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cacheMs = options.cacheMs ?? 15_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message, error) => console.error(message, error));
  let pool: pg.Pool | undefined;
  let cached: { at: number; report: Promise<ReadinessReport> } | undefined;

  const run = async (): Promise<ReadinessReport> => {
    if (!connectionString) {
      return report({
        database: { status: 'fail', detail: 'DATABASE_URL is not set' },
        role: NEEDS_DATABASE,
        tls: NEEDS_DATABASE,
        tenantIsolation: NEEDS_DATABASE,
      });
    }
    let config: pg.PoolConfig;
    try {
      config = connectionConfig(connectionString);
    } catch (error) {
      log('Readiness: DATABASE_URL is not usable', error);
      return report({
        database: { status: 'fail', detail: 'DATABASE_URL is not a valid connection string' },
        role: NEEDS_DATABASE,
        tls: NEEDS_DATABASE,
        tenantIsolation: NEEDS_DATABASE,
      });
    }
    const tls = evaluateTls(connectionString, config);
    pool ??= createPool(config, timeoutMs, log);
    try {
      const { role, tables } = await withTimeout(queryState(pool), timeoutMs);
      return report({
        database: { status: 'pass', detail: 'connected' },
        role: evaluateRole(role),
        tls,
        tenantIsolation: evaluateTenantIsolation(tables),
      });
    } catch (error) {
      log('Readiness: database check failed', error);
      return report({
        database: { status: 'fail', detail: describeDatabaseError(error) },
        role: NEEDS_DATABASE,
        tls,
        tenantIsolation: NEEDS_DATABASE,
      });
    }
  };

  return () => {
    const at = now();
    if (!cached || at - cached.at >= cacheMs) cached = { at, report: run() };
    return cached.report;
  };
}

function report(checks: ReadinessReport['checks']): ReadinessReport {
  return { ready: Object.values(checks).every((c) => c.status !== 'fail'), checks };
}

function createPool(
  config: pg.PoolConfig,
  timeoutMs: number,
  log: NonNullable<ReadinessProbeOptions['log']>,
): pg.Pool {
  const pool = new pg.Pool({
    ...config,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  // An idle client that loses its connection emits here; unhandled, it would crash the process.
  pool.on('error', (error) => log('Readiness: idle database connection failed', error));
  return pool;
}

export interface RoleRow {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypass: boolean;
}

export interface TableRow {
  readonly table: string;
  readonly rls: boolean;
  readonly forced: boolean;
}

/** Plain queries on catalogs every role can read; no parameters, so any pooler mode works. */
async function queryState(
  pool: pg.Pool,
): Promise<{ role: RoleRow | undefined; tables: TableRow[] }> {
  const client = await pool.connect();
  try {
    const role = await client.query<RoleRow>(
      `select current_user as role, r.rolsuper as superuser, r.rolbypassrls as bypass
         from pg_roles r where r.rolname = current_user`,
    );
    const tables = await client.query<TableRow>(
      `select c.relname as "table", c.relrowsecurity as rls, c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (c.relname = 'organizations' or exists (
                select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped))
        order by 1`,
    );
    return { role: role.rows[0], tables: tables.rows };
  } finally {
    client.release();
  }
}

export function evaluateRole(row: RoleRow | undefined): ReadinessCheck {
  if (!row) return { status: 'fail', detail: 'could not read the connected role' };
  if (row.superuser || row.bypass) {
    return {
      status: 'fail',
      detail: `connected as ${row.role}, which bypasses row-level security; use ${RUNTIME_ROLE}`,
    };
  }
  if (row.role !== RUNTIME_ROLE) {
    return { status: 'fail', detail: `connected as ${row.role}; expected ${RUNTIME_ROLE}` };
  }
  return { status: 'pass', detail: `connected as ${RUNTIME_ROLE}` };
}

export function evaluateTenantIsolation(rows: readonly TableRow[]): ReadinessCheck {
  if (rows.length < MIN_TENANT_TABLES) {
    return {
      status: 'fail',
      detail: `found ${rows.length} tenant tables, expected at least ${MIN_TENANT_TABLES}; run migrations`,
    };
  }
  const exposed = rows
    .filter((r) => !r.rls || (!r.forced && !UNFORCED_TABLES.has(r.table)))
    .map((r) => r.table);
  if (exposed.length > 0) {
    return { status: 'fail', detail: `row-level security not enforced on: ${exposed.join(', ')}` };
  }
  return { status: 'pass', detail: `row-level security enforced on ${rows.length} tenant tables` };
}

export function evaluateTls(connectionString: string, config: pg.PoolConfig): ReadinessCheck {
  const ssl = config.ssl;
  if (typeof ssl === 'object' && ssl.rejectUnauthorized === true && ssl.ca) {
    return { status: 'pass', detail: "verified against Supabase's root certificate" };
  }
  if (LOCAL_HOSTS.has(new URL(connectionString).hostname)) {
    return { status: 'skip', detail: 'local database; TLS not required' };
  }
  return { status: 'fail', detail: 'the connection is not TLS-verified' };
}

/** Maps a driver error to a fixed message, so the report never echoes hosts or credentials. */
export function describeDatabaseError(error: unknown): string {
  const codes: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    if (e instanceof TimeoutError) return 'timed out';
  }
  if (codes.includes('28P01')) return 'password rejected';
  if (codes.includes('28000')) return 'role not allowed to connect';
  if (codes.some((c) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(c))) {
    return 'database unreachable';
  }
  if (
    codes.some(
      (c) => c.includes('CERT') || c.startsWith('ERR_TLS') || c === 'DEPTH_ZERO_SELF_SIGNED_CERT',
    )
  ) {
    return 'TLS verification failed';
  }
  return 'could not connect or query';
}

class TimeoutError extends Error {}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
