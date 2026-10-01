import type pg from 'pg';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

const SUPABASE_HOST = /\.supabase\.(co|com)$/i;

/**
 * Turns a connection string into pg pool settings. For Supabase hosts, TLS is always on and
 * the server certificate is verified against Supabase's root CA. Any sslmode in the URL is
 * dropped, because node-postgres lets URL parameters override the ssl object and its
 * sslmode=require verifies against Node's store, which lacks Supabase's CA.
 */
export function connectionConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  if (!SUPABASE_HOST.test(url.hostname)) return { connectionString };
  for (const param of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
    url.searchParams.delete(param);
  }
  return {
    connectionString: url.toString(),
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  };
}
