import { supabase } from './supabase';

/** A problem document from the API (RFC 9457), as an error. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = 'ApiProblem';
  }
}

/** Calls our API as the signed-in user. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = (await supabase()?.auth.getSession())?.data.session;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.access_token}` } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    title?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new ApiProblem(res.status, body.code, body.title ?? 'Something went wrong', body.detail);
  }
  return body as T;
}
