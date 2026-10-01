import type pg from 'pg';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

const SUPABASE_HOST = /\.supabase\.(co|com)$/i;
const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/i;
const PASSWORD_PLACEHOLDER = /YOUR[-_ ]?PASSWORD/i;

/** Postgres SQLSTATE for a rejected password. */
const INVALID_PASSWORD = '28P01';

/**
 * Turns a connection string into pg pool settings. For Supabase hosts, TLS is always on and
 * the server certificate is verified against Supabase's root CA. Any sslmode in the URL is
 * dropped, because node-postgres lets URL parameters override the ssl object and its
 * sslmode=require verifies against Node's store, which lacks Supabase's CA.
 */
export function connectionConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  if (!SUPABASE_HOST.test(url.hostname)) return { connectionString };
  tidySupabasePassword(url);
  for (const param of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
    url.searchParams.delete(param);
  }
  return {
    connectionString: url.toString(),
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  };
}

export interface ConnectionSummary {
  readonly user: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  /** Corrections applied to the password, for the log. Never contains the password. */
  readonly corrections: readonly string[];
}

/** What a connection string points at, safe to log: it never includes the password. */
export function describeConnection(connectionString: string): ConnectionSummary {
  const url = new URL(connectionString);
  const corrections = SUPABASE_HOST.test(url.hostname) ? tidySupabasePassword(url) : [];
  return {
    user: decodeURIComponent(url.username),
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(default)',
    corrections,
  };
}

/**
 * Supabase's connection-string template reads `:[YOUR-PASSWORD]@`, and pasting a password
 * into it tends to leave the brackets or a space behind. Postgres then receives them as part
 * of the password and rejects it. Supabase never generates passwords with surrounding brackets
 * or spaces, so they are removed; a placeholder left in place is an error.
 */
function tidySupabasePassword(url: URL): string[] {
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    return [];
  }
  if (PASSWORD_PLACEHOLDER.test(password)) {
    throw new Error(
      "The connection string still contains Supabase's [YOUR-PASSWORD] placeholder. " +
        'Replace it, brackets included, with the database password.',
    );
  }
  if (password === '') throw new Error('The connection string has no password.');
  const corrections: string[] = [];
  const trimmed = password.trim();
  if (trimmed !== password) {
    corrections.push('removed spaces around the password');
    password = trimmed;
  }
  if (password.length > 2 && password.startsWith('[') && password.endsWith(']')) {
    corrections.push(
      "removed the square brackets around the password (they belong to Supabase's placeholder)",
    );
    password = password.slice(1, -1);
  }
  if (corrections.length > 0) url.password = encodeURIComponent(password);
  return corrections;
}

export interface PasswordRetryOptions {
  /** Waits between attempts. The default spans about 90 seconds. */
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

/**
 * Supabase's pooler caches credentials apart from the database. After a password reset it can
 * reject the new, correct password until a fresh connection makes it reload, usually within
 * seconds. Retries `work` while the pooler rejects the password, then fails with what to check.
 * Other connection strings run `work` once.
 */
export async function retryWhilePoolerRejectsPassword<T>(
  connectionString: string,
  work: () => Promise<T>,
  options: PasswordRetryOptions = {},
): Promise<T> {
  if (!SUPABASE_POOLER_HOST.test(new URL(connectionString).hostname)) return work();
  const delays = options.delaysMs ?? [15_000, 30_000, 45_000];
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isInvalidPassword(error)) throw error;
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new Error(
          `Supabase rejected the database password ${attempt + 1} times. Either the password ` +
            'in the connection string differs from the one set in Supabase, or the pooler has ' +
            'not picked up a recent reset. To force it: Supabase → Database → Settings → ' +
            'Connection pooling, change the pool size by one and save, then change it back.',
          { cause: error },
        );
      }
      options.log?.(
        `Supabase rejected the password (attempt ${attempt + 1}); its pooler can lag ` +
          `behind a password reset. Retrying in ${delay / 1000} s.`,
      );
      await sleep(delay);
    }
  }
}

function isInvalidPassword(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === INVALID_PASSWORD) return true;
  }
  return false;
}
