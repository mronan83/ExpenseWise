import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { connectionConfig } from './connection.ts';

const ITERATIONS = 4096;

/**
 * Postgres's stored form of a SCRAM-SHA-256 password. Sending this instead of the plain
 * password means the secret never appears in statement logs or pg_stat_statements.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export const RUNTIME_ROLES = ['expensewise_app', 'expensewise_relay'] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export interface SetRolePasswordsOptions {
  /**
   * Whether the role can already sign in with this password. Roles that can are left alone:
   * every new verifier gets a new salt, and Supabase's pooler keeps rejecting the role until
   * it reloads its cached credentials, which can take until someone restarts it.
   */
  readonly alreadyWorks?: (role: RuntimeRole, password: string) => Promise<boolean>;
  readonly log?: (message: string) => void;
}

/**
 * Gives the runtime roles LOGIN and a password, then checks neither can bypass row-level
 * security. Migration 0001 creates the roles NOLOGIN; passwords never live in migrations
 * and don't survive a restore or a new project, so this runs after every migration.
 */
export async function setRolePasswords(
  client: pg.ClientBase,
  passwords: Readonly<Record<RuntimeRole, string>>,
  options: SetRolePasswordsOptions = {},
): Promise<void> {
  for (const role of RUNTIME_ROLES) {
    const password = passwords[role];
    if (password.length < 24) {
      throw new Error(`The password for ${role} must be at least 24 characters`);
    }
    if (await options.alreadyWorks?.(role, password)) {
      options.log?.(`${role} already signs in with its password; left unchanged.`);
      continue;
    }
    const verifier = client.escapeLiteral(scramSha256Verifier(password));
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${verifier}`,
    );
    options.log?.(`${role}: password set.`);
  }
  const { rows } = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>('select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1)', [
    RUNTIME_ROLES,
  ]);
  for (const role of RUNTIME_ROLES) {
    const row = rows.find((r) => r.rolname === role);
    if (!row) throw new Error(`Role ${role} does not exist. Run migrations first.`);
    if (row.rolsuper || row.rolbypassrls) {
      throw new Error(`Role ${role} can bypass row-level security. Refusing to continue.`);
    }
  }
}

/**
 * The connection string a runtime role would use: the same host, port and database as
 * `base`, with the role's name and password. Supabase's pooler names users
 * `<role>.<project-ref>`, so a suffix on the base user is kept.
 */
export function roleConnectionString(base: string, role: RuntimeRole, password: string): string {
  const url = new URL(base);
  const user = decodeURIComponent(url.username);
  const dot = user.indexOf('.');
  url.username = encodeURIComponent(dot === -1 ? role : `${role}${user.slice(dot)}`);
  url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * Whether `connectionString` can open a session. Any failure counts as no: a role without
 * LOGIN, a wrong password, or a pooler that hasn't caught up. The caller then sets the
 * password, which is what it would have done without asking.
 */
export async function canSignIn(
  connectionString: string,
  log?: (message: string) => void,
): Promise<boolean> {
  const client = new pg.Client({
    ...connectionConfig(connectionString),
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    log?.(`Sign-in check failed${typeof code === 'string' ? ` (${code})` : ''}.`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
