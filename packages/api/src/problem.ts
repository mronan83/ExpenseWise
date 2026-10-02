import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const PROBLEM_BASE = 'https://expensewise.dev/problems/';

/** RFC 9457 extension members: a machine-readable code, and any ids the client needs. */
export type ProblemExtra = { detail?: string; code?: string } & Record<string, unknown>;

/** Responds with an RFC 9457 problem document. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  slug: string,
  title: string,
  extra: ProblemExtra = {},
  headers: Record<string, string> = {},
) {
  return c.json({ type: `${PROBLEM_BASE}${slug}`, title, status, ...extra }, status, {
    ...headers,
    'Content-Type': 'application/problem+json',
  });
}

/**
 * A request that ends in a problem document, thrown from a handler or guard and rendered by
 * the API's error handler. It is an expected outcome, so it never reaches error tracking.
 */
export class ProblemError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly slug: string,
    readonly title: string,
    readonly extra: ProblemExtra = {},
  ) {
    super(title);
    this.name = 'ProblemError';
  }
}
