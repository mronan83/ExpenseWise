import { v7 as uuidv7, validate } from 'uuid';

/**
 * Time-ordered UUIDv7. Safe to generate on a phone while offline, so the ID
 * doubles as the idempotency key when a capture syncs later.
 */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: string): boolean {
  return validate(value);
}
