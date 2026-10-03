import { describe, expect, it } from 'vitest';
import { derivedId, isUuid, newId } from './ids.ts';

describe('ids', () => {
  it('creates time-ordered version 7 UUIDs', () => {
    const ids = Array.from({ length: 50 }, newId);
    expect(ids.every(isUuid)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('derives the same version 5 UUID from the same name, and another from another', () => {
    const id = derivedId('email:bird:rem_1:abc');
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect(derivedId('email:bird:rem_1:abc')).toBe(id);
    expect(derivedId('email:bird:rem_2:abc')).not.toBe(id);
  });

  it('rejects malformed ids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
