import type { MemberRole } from './approvals.ts';
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

/**
 * Who reads an organization's audit trail (FR-GOV-06): its owners, finance admins and
 * auditors. Members and approvers don't.
 */
export const AUDIT_READER_ROLES: readonly MemberRole[] = ['owner', 'finance_admin', 'auditor'];

export const canReadAuditTrail = (role: MemberRole): boolean => AUDIT_READER_ROLES.includes(role);

/** Field names that only ever hold a credential. A hint such as `keyHint` is not one. */
const SECRET_NAME =
  /^(api_?key|secret|client_?secret|password|passphrase|token|access_?token|refresh_?token|id_?token|bearer|authorization|cookie|private_?key|ciphertext|signing_?key)$/i;

/** Values shaped like a credential: a provider key, a JWT, a cloud or chat token. */
const SECRET_VALUE =
  /^(sk-[\w-]{16,}|sk_(live|test)_\w{16,}|rk_(live|test)_\w{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*)$/;

/**
 * The paths of the fields in an event's details that look like a secret, by name or by
 * value. The trail shows details as stored, so none may hold one; the checks use this to
 * prove it.
 */
export function secretLikeFields(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return SECRET_VALUE.test(value.trim()) ? [path || '(value)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => secretLikeFields(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const at = path ? `${path}.${k}` : k;
      if (SECRET_NAME.test(k) && v !== null && v !== '') return [at];
      return secretLikeFields(v, at);
    });
  }
  return [];
}
