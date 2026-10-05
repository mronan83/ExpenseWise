import { describe, expect, it } from 'vitest';
import {
  afterSecondFactor,
  asksForCode,
  authenticatorOffer,
  MAX_AUTHENTICATORS,
  readSecondFactorCode,
  SECOND_FACTOR_CODE_LENGTH,
} from './second-factor.ts';

describe('the code from an authenticator app', () => {
  it('is 6 digits, read without the spaces or dash an app shows', () => {
    expect(SECOND_FACTOR_CODE_LENGTH).toBe(6);
    expect(readSecondFactorCode('123456')).toBe('123456');
    expect(readSecondFactorCode(' 123 456 ')).toBe('123456');
    expect(readSecondFactorCode('123-456')).toBe('123456');
  });

  it('is refused when it is anything but 6 digits', () => {
    for (const typed of ['', '12345', '1234567', '12345a', 'abcdef', '１２３４５６']) {
      expect(readSecondFactorCode(typed)).toBeNull();
    }
  });
});

describe('asking for the code at sign-in', () => {
  it('asks someone with an authenticator who signed in with a password alone, while it is on', () => {
    expect(asksForCode({ current: 'aal1', next: 'aal2' }, true)).toBe(true);
  });

  it('asks no one while the second factor is switched off, whatever they enrolled', () => {
    expect(asksForCode({ current: 'aal1', next: 'aal2' }, false)).toBe(false);
  });

  it('asks no one without an authenticator, and no one who already passed it', () => {
    expect(asksForCode({ current: 'aal1', next: 'aal1' }, true)).toBe(false);
    expect(asksForCode({ current: 'aal2', next: 'aal2' }, true)).toBe(false);
    expect(asksForCode({ current: null, next: null }, true)).toBe(false);
  });
});

describe('adding an authenticator app', () => {
  it('is offered to everyone while it is on, and suggests a second to someone with one', () => {
    expect(authenticatorOffer({ switchedOn: true, owner: false, enrolled: 0 })).toEqual({
      shown: true,
      canAdd: true,
      beforeSwitchingOn: false,
      suggestAnother: false,
    });
    expect(authenticatorOffer({ switchedOn: true, owner: false, enrolled: 1 })).toMatchObject({
      canAdd: true,
      suggestAnother: true,
    });
  });

  it('is offered to the owner alone while it is off, so the owner can pass it before switching it on', () => {
    expect(authenticatorOffer({ switchedOn: false, owner: true, enrolled: 0 })).toMatchObject({
      shown: true,
      canAdd: true,
      beforeSwitchingOn: true,
    });
    expect(authenticatorOffer({ switchedOn: false, owner: false, enrolled: 0 })).toMatchObject({
      shown: false,
      canAdd: false,
    });
  });

  it('still shows someone their own while it is off, to remove, without offering another', () => {
    expect(authenticatorOffer({ switchedOn: false, owner: false, enrolled: 2 })).toMatchObject({
      shown: true,
      canAdd: false,
    });
  });

  it('stops at 10, Supabase Auth’s own limit', () => {
    expect(MAX_AUTHENTICATORS).toBe(10);
    expect(authenticatorOffer({ switchedOn: true, owner: true, enrolled: 9 }).canAdd).toBe(true);
    expect(authenticatorOffer({ switchedOn: true, owner: true, enrolled: 10 }).canAdd).toBe(false);
  });
});

describe('where the code screen goes next', () => {
  it('goes back to the page that asked, on this site only', () => {
    expect(afterSecondFactor('/settings/people')).toBe('/settings/people');
    expect(afterSecondFactor('/expenses?from=2026-10-01')).toBe('/expenses?from=2026-10-01');
  });

  it('goes Home for anything else: no page, another site, or the sign-in screens', () => {
    for (const next of [
      null,
      '',
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      '/sign-in/code',
      'settings',
    ]) {
      expect(afterSecondFactor(next)).toBe('/');
    }
  });
});
