import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const PROBLEM_BASE = 'https://expensewise.dev/problems/';

/** Responds with an RFC 9457 problem document. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  slug: string,
  title: string,
  extra: { detail?: string; code?: string } = {},
) {
  return c.json({ type: `${PROBLEM_BASE}${slug}`, title, status, ...extra }, status, {
    'Content-Type': 'application/problem+json',
  });
}
