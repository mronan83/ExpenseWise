/**
 * Patterns for credentials that can end up inside error messages: connection strings,
 * bearer tokens and vendor keys. Error tracking runs every message through redactSecrets.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // postgresql://user:password@host → postgresql://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  // JWTs (Supabase access tokens) anywhere in a message.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'],
  // Anthropic, Supabase, Inngest, PostHog and Stripe-style keys.
  [/\b(sk-ant-|sb_secret_|signkey-|phx_|phs_|sk_live_|sk_test_)[A-Za-z0-9_-]+/g, '$1[redacted]'],
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/** The parts of an error-tracking event that carry free text. */
export interface RedactableEvent {
  message?: string;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string }[];
}

/** Redacts credentials from an event's message, exception values and breadcrumbs, in place. */
export function redactEvent<T extends RedactableEvent>(event: T): T {
  if (event.message) event.message = redactSecrets(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactSecrets(exception.value);
  }
  // Console output becomes breadcrumbs, and the API logs errors before reporting them.
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = redactSecrets(crumb.message);
  }
  return event;
}
