import { v5 as uuidv5, v7 as uuidv7, validate } from 'uuid';

/**
 * Time-ordered UUIDv7. Safe to generate on a phone while offline, so the ID
 * doubles as the idempotency key when a capture syncs later.
 */
export function newId(): string {
  return uuidv7();
}

/** The namespace of every derived id, fixed for good: changing it changes every derived id. */
const DERIVED_ID_NAMESPACE = '5bd01ee9-b61e-437b-88b7-1be121af3bef';

/**
 * The same UUID for the same name, every time (UUIDv5). For a record made from something
 * outside, such as an emailed file, so that a retried step makes the same record again
 * instead of a second one.
 */
export function derivedId(name: string): string {
  return uuidv5(name, DERIVED_ID_NAMESPACE);
}

export function isUuid(value: string): boolean {
  return validate(value);
}
