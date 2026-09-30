import { DomainError } from './errors.ts';

/** Hash that precedes the first event of every organization's chain. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEventInput {
  readonly orgId: string;
  readonly sequence: number;
  readonly actor: { readonly type: 'user' | 'system'; readonly id: string | null };
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ChainedAuditEvent extends AuditEventInput {
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * Deterministic JSON: object keys sorted at every level, so the same event
 * always hashes the same way regardless of property order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DomainError('invalid_audit_payload', 'Audit payloads cannot hold NaN or Infinity');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new DomainError('invalid_audit_payload', `Cannot hash a value of type ${typeof value}`);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Links an event to the one before it. Changing any past event breaks every later hash. */
export async function chainAuditEvent(
  prevHash: string,
  event: AuditEventInput,
): Promise<ChainedAuditEvent> {
  const hash = await sha256Hex(canonicalJson({ prevHash, event }));
  return Object.freeze({ ...event, prevHash, hash });
}

/** Recomputes the chain. Returns the index of the first event that doesn't verify. */
export async function verifyAuditChain(
  events: readonly ChainedAuditEvent[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly brokenAt: number }> {
  let expectedPrev = GENESIS_HASH;
  for (const [index, event] of events.entries()) {
    const { prevHash, hash, ...input } = event;
    if (prevHash !== expectedPrev) return { ok: false, brokenAt: index };
    const recomputed = await chainAuditEvent(prevHash, input);
    if (recomputed.hash !== hash) return { ok: false, brokenAt: index };
    expectedPrev = hash;
  }
  return { ok: true };
}
