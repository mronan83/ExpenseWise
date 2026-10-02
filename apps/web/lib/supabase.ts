import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null | undefined;

/**
 * The browser's Supabase client, for sign-in only (ADR-0013): data always goes through our
 * own API. Null when this deployment has no Supabase project configured.
 */
export function supabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  client = url && key ? createClient(url, key) : null;
  return client;
}

/**
 * Signs in to another account without touching the current session, hands its access token
 * to `withToken`, then ends that throwaway session. Linking sign-ins uses it to prove the person
 * controls both; the token goes to our API once and is never stored.
 */
export async function withOtherSignIn<T>(
  email: string,
  password: string,
  withToken: (accessToken: string) => Promise<T>,
): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Sign-in isn't configured on this deployment.");
  const other = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'expensewise-other-sign-in',
    },
  });
  const { data, error } = await other.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new OtherSignInError(error?.message ?? 'Sign-in failed');
  try {
    return await withToken(data.session.access_token);
  } finally {
    await other.auth.signOut({ scope: 'local' });
  }
}

/** The other account's email and password were not accepted. */
export class OtherSignInError extends Error {
  override name = 'OtherSignInError';
}
