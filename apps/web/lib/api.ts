import { isStepUp, stepUp } from './step-up';
import { supabase } from './supabase';

/** Requests being sent again after the code, so one is never asked about twice. */
const stepping = new WeakSet<RequestInit>();

/** A problem document from the API (RFC 9457), as an error. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    title: string,
    readonly detail?: string,
    /** Other members of the problem document, such as the id of an existing receipt. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(title);
    this.name = 'ApiProblem';
  }
}

/**
 * Calls our API as the signed-in user. A request that needs the second factor, an admin action
 * (FR-GOV-04) or, for someone with an authenticator whose organization asks it before anything
 * else, any read or change (#85), asks for the code where the app shows its prompt, then is
 * sent again, once, as the session that passed it; without the code it fails as any refusal
 * does.
 */
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
  } & Record<string, unknown>;
  if (!res.ok) {
    // Only a body that can be sent twice; the retry carries the new session's token.
    const resendable = init.body === undefined || typeof init.body === 'string';
    if (isStepUp(res.status, body.code) && resendable && !stepping.has(init) && (await stepUp())) {
      stepping.add(init);
      try {
        return await api<T>(path, init);
      } finally {
        stepping.delete(init);
      }
    }
    throw new ApiProblem(
      res.status,
      body.code,
      body.title ?? 'Something went wrong',
      body.detail,
      body,
    );
  }
  return body as T;
}

/**
 * Downloads a file from our API as the signed-in user, such as a report's CSV, under the name
 * the API gives it. A problem document becomes an ApiProblem, as with `api`, and one asking
 * for the second factor asks for the code, then downloads once more (#85).
 */
export async function apiDownload(
  path: string,
  fallbackName: string,
  afterCode = false,
): Promise<void> {
  const session = (await supabase()?.auth.getSession())?.data.session;
  const res = await fetch(`/api${path}`, {
    headers: session ? { authorization: `Bearer ${session.access_token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      title?: string;
      detail?: string;
    } & Record<string, unknown>;
    if (isStepUp(res.status, body.code) && !afterCode && (await stepUp())) {
      return apiDownload(path, fallbackName, true);
    }
    throw new ApiProblem(
      res.status,
      body.code,
      body.title ?? 'Something went wrong',
      body.detail,
      body,
    );
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = named?.[1] ?? fallbackName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Safari starts the download after the click returns; give it a moment before letting go.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
