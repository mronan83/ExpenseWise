import { describe, expect, it } from 'vitest';
import { isUuid, newId } from './ids.ts';

describe('ids', () => {
  it('creates time-ordered version 7 UUIDs', () => {
    const ids = Array.from({ length: 50 }, newId);
    expect(ids.every(isUuid)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects malformed ids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
