import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

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

/**
 * Gives the runtime roles LOGIN and a password, then checks neither can bypass row-level
 * security. Migration 0001 creates the roles NOLOGIN; passwords never live in migrations
 * and don't survive a restore or a new project, so this runs after every migration.
 */
export async function setRolePasswords(
  client: pg.ClientBase,
  passwords: Readonly<Record<RuntimeRole, string>>,
): Promise<void> {
  for (const role of RUNTIME_ROLES) {
    const password = passwords[role];
    if (password.length < 24) {
      throw new Error(`The password for ${role} must be at least 24 characters`);
    }
    const verifier = client.escapeLiteral(scramSha256Verifier(password));
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${verifier}`,
    );
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
