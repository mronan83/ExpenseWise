import { describe, expect, it } from 'vitest';
import {
  admission,
  afterSecondFactor,
  asksForCode,
  authenticatorOffer,
  hasAuthenticatorThatCounts,
  LET_IN_HOURS,
  MAX_AUTHENTICATORS,
  mayLetIn,
  readSecondFactorCode,
  SECOND_FACTOR_CODE_LENGTH,
  type SignInStanding,
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

/* Only an email a person lets in signs in, once they have an authenticator (#90, Q44). */

const standing = (over: Partial<SignInStanding> = {}): SignInStanding => ({
  authenticator: false,
  personAuthenticator: false,
  letIn: 'no',
  personLetIn: 'none',
  firstSignIn: false,
  ...over,
});
const both = (s: SignInStanding) => [admission(s, 'aal1'), admission(s, 'aal2')];

describe('which emails sign in, once a person has an authenticator', () => {
  it('asks nothing more of a person with no authenticator on any email', () => {
    expect(both(standing())).toEqual(['open', 'open']);
    expect(hasAuthenticatorThatCounts(standing())).toBe(false);
  });

  it('lets in the email a person first signed in with once it passes its own code, while none is let in', () => {
    const first = standing({ authenticator: true, personAuthenticator: true, firstSignIn: true });
    expect(both(first)).toEqual(['code', 'let_in_first']);
  });

  it('refuses another of a person’s emails that passes its own code while none is let in: it waits to be let in from the first (#91)', () => {
    // Before #91 the first of their emails to pass its code was let in, whichever it was.
    const another = standing({ authenticator: true, personAuthenticator: true });
    expect(both(another)).toEqual(['not_let_in', 'not_let_in']);
  });

  it('asks the email a person first signed in with to add its own authenticator while another has one and none is let in, then lets it in (#91)', () => {
    const first = standing({ personAuthenticator: true, firstSignIn: true });
    expect(both(first)).toEqual(['own_authenticator', 'own_authenticator']);
    expect(both({ ...first, authenticator: true })).toEqual(['code', 'let_in_first']);
  });

  it('lets no email in on its own once none of a person’s emails is the one they first signed in with, as when it was unlinked (#91)', () => {
    for (const authenticator of [false, true]) {
      expect(both(standing({ authenticator, personAuthenticator: true }))).toEqual([
        'not_let_in',
        'not_let_in',
      ]);
    }
    // With no authenticator on any of them, nothing is asked, as before.
    expect(both(standing())).toEqual(['open', 'open']);
  });

  it('asks the same of a person with only one email as before: it is the one they first signed in with (#91)', () => {
    const only = { firstSignIn: true };
    expect(both(standing(only))).toEqual(['open', 'open']);
    const enrolled = standing({ ...only, authenticator: true, personAuthenticator: true });
    expect(both(enrolled)).toEqual(['code', 'let_in_first']);
    expect(both({ ...enrolled, letIn: 'yes', personLetIn: 'with_authenticator' as const })).toEqual(
      ['code', 'open'],
    );
  });

  it('cares which email was first only while none is let in: once one is, another is let in from it, the first included', () => {
    const letInElsewhere = {
      personAuthenticator: true,
      personLetIn: 'with_authenticator' as const,
    };
    for (const firstSignIn of [false, true]) {
      expect(both(standing({ ...letInElsewhere, firstSignIn, authenticator: true }))).toEqual([
        'not_let_in',
        'not_let_in',
      ]);
      expect(
        both(standing({ ...letInElsewhere, firstSignIn, authenticator: true, letIn: 'waiting' })),
      ).toEqual(['code', 'passed']);
    }
  });

  it('refuses an email not let in, whatever its session says, once the person has an authenticator that counts', () => {
    // Before any is let in, an email other than the first, with none of its own, isn't offered
    // a way in.
    expect(both(standing({ personAuthenticator: true }))).toEqual(['not_let_in', 'not_let_in']);
    // Once one is let in, an authenticator added to another email counts for nothing.
    for (const authenticator of [false, true]) {
      const other = standing({
        authenticator,
        personAuthenticator: true,
        personLetIn: 'with_authenticator',
      });
      expect(both(other)).toEqual(['not_let_in', 'not_let_in']);
    }
  });

  it('asks an email let in with an authenticator for its code, and lets it through once passed', () => {
    const letIn = standing({
      authenticator: true,
      personAuthenticator: true,
      letIn: 'yes',
      personLetIn: 'with_authenticator',
    });
    expect(both(letIn)).toEqual(['code', 'open']);
  });

  it('holds an email let in until it adds its own authenticator, then keeps it let in once it passes its code', () => {
    const waiting = standing({
      personAuthenticator: true,
      letIn: 'waiting',
      personLetIn: 'with_authenticator',
    });
    expect(both(waiting)).toEqual(['own_authenticator', 'own_authenticator']);
    expect(both({ ...waiting, authenticator: true })).toEqual(['code', 'passed']);
    // One let in for good that lost its own is held the same way.
    expect(both({ ...waiting, letIn: 'yes' })).toEqual(['own_authenticator', 'own_authenticator']);
  });

  it('asks nothing more of anyone once every email let in has lost its authenticator, and never lets another in first then', () => {
    const lost = { personLetIn: 'without_authenticator' as const };
    expect(both(standing({ ...lost, letIn: 'yes' }))).toEqual(['open', 'open']);
    // An email not let in with one of its own: it counts for nothing, and isn't the first.
    expect(
      both(standing({ ...lost, authenticator: true, personAuthenticator: true, letIn: 'no' })),
    ).toEqual(['open', 'open']);
    expect(hasAuthenticatorThatCounts(standing({ ...lost, personAuthenticator: true }))).toBe(
      false,
    );
  });

  it('lets only an email let in, with its own authenticator, past its code, let another in or withdraw one', () => {
    const letIn = { authenticator: true, letIn: 'yes' as const };
    expect(mayLetIn(letIn, 'aal2')).toBe(true);
    expect(mayLetIn(letIn, 'aal1')).toBe(false);
    expect(mayLetIn({ ...letIn, letIn: 'waiting' }, 'aal2')).toBe(false);
    expect(mayLetIn({ ...letIn, letIn: 'no' }, 'aal2')).toBe(false);
    expect(mayLetIn({ ...letIn, authenticator: false }, 'aal2')).toBe(false);
  });

  it('gives an email let in from another 24 hours to pass its own code', () => {
    expect(LET_IN_HOURS).toBe(24);
  });
});
