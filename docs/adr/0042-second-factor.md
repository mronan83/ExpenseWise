# ADR-0042: A code from an authenticator app at sign-in and before admin actions, behind its own switch

People add an authenticator app (TOTP) in Settings › Sign-ins through Supabase Auth. While their organization has the second factor switched on, signing in asks for its code before anything else, and every admin action needs a session that passed it (aal2). Switching it on needs the owner's own code, so no one is locked out, and the server's override switches all of it off.

- **Status:** Accepted (building the second factor in the same batch as approval, behind its own switch, decided by product owner, Oct 5, Q40; TOTP through Supabase Auth from the blueprint, ADR-0013; when the code is asked, who may add one while it is off, the no-lockout rule and what counts as an admin action recommended, no objection yet); Amended by [ADR-0044](0044-second-factor-everywhere.md) (every request of someone with an authenticator needs the code, and linking a sign-in always does, Q41)
- **Date:** 2026-10-05
- **Deciders:** Product owner (Q40); Claude (principal architect), for the design
- **Decision register:** D-44. Builds on [ADR-0013](0013-supabase-platform.md) (Supabase Auth, our API for data), [ADR-0032](0032-features-switched-per-organization.md) (each feature switched per organization) and [ADR-0035](0035-own-records-and-invite-links.md) (roles); closes GAP-03 (#8).

## Context

Real financial records sat behind a password alone (GAP-03). FR-PLT-03 asks sign-in for a second factor once enrolled; FR-GOV-04 asks for one in the session before approving someone else's spend and before every admin action. The API already read the token's `aal` claim into `Identity.assuranceLevel`, and `requireSecondFactor()` refuses anything below aal2 with 403 `second_factor_required`, for approval (#24) and admin actions to share.

Four facts shape it:

- **Supabase Auth does the cryptography.** TOTP is on in every Supabase project by default. The browser enrolls a factor (a QR code and its key), and verifying its first code, or any later code, promotes the session to aal2 and signs out the person's other sessions. A verified factor is removed, and another added, only from an aal2 session.
- **Everything new ships switched off** (ADR-0032), and the override is the server's kill switch.
- **Switching it on can lock out the switcher.** If admin actions needed aal2 the moment it was on, an owner without an authenticator could no longer change anything, including the switch.
- **Our API is the only path to data** (ADR-0013). Supabase's own policies on `aal` don't apply to it.

## Decision

1. **Enrolling.** Settings › Sign-ins lists a person's authenticator apps, each with its name and when it was added, adds one by its QR code or key and its first code, and removes one, asking for the code first when Supabase wants it. Up to 10 (R-AUTHENTICATORS-MAX, Supabase's own limit). It is offered while the organization has the second factor on, and to its owner while it is off. Anyone who already has one sees it, to remove it. The page suggests a second, so losing one phone doesn't lock anyone out.
2. **At sign-in.** While the switch is on, a session at aal1 of someone with a verified factor (Supabase: next level aal2) goes to the code screen before anything else, with a way to sign out: straight from the Sign in page, and from any screen it opens later. Off, sign-in is as it was, whoever enrolled, so the override stops the code at sign-in too.
3. **Admin actions** (FR-GOV-04). While the switch is on, every change an owner or finance admin makes to how the organization works needs aal2, checked after the role check by one helper, `requireAdminSecondFactor(features, orgId, identity)`: feature switches, the organization's details and duplicate window, people and invite links, AI provider keys (saving, testing, removing), AI model settings, the route-mileage key, mileage rates, and categories and types. Reading settings, and each member's own records, need only the password. Off, nothing changes.
4. **No lockout.** Switching the second factor on is refused unless the owner's own session is aal2, so the owner has added an authenticator and passed it. Switching it off while it is on is an admin action, so a password alone can't undo it.
5. **Asked in the middle of an action.** When an admin action answers `second_factor_required`, the web app shows the code on its own, keeping the page underneath, and sends the action again once it is in; without a factor it says where to add one. The same prompt serves Supabase's own demand when adding or removing an authenticator.
6. **Recovery.** Someone who loses their only authenticator has it removed from Supabase by the owner (the runbook says how), then signs in with the password and adds a new one. `FLAG_OVERRIDES=security.second-factor=off` turns the whole feature off for every organization at once.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Ask for the code at sign-in whether or not the switch is on | The override would then leave everyone with an authenticator facing a code the rest of the app ignores; a feature that is off should look absent (ADR-0032). |
| Offer enrolling only while the switch is on | The owner could then never switch it on: switching needs their own code. |
| Let anyone switch it on and ask for the code from then on | An owner without an authenticator would be locked out of every admin action at once, the switch included. |
| Refuse every request of an enrolled person at aal1 | The API can't tell from the token who has enrolled; reading Supabase's factors per request means a call out or a grant on its `auth` schema. Recorded as GAP-33 (#85), asked as Q41. |
| Recovery codes | Supabase's are experimental. A second authenticator does the same job, and the owner can remove a lost one. |
| Our own TOTP secrets and checks | Secrets to keep and a check to get right, when Supabase does both and already issues the `aal` claim the API trusts. |

## Consequences

### Positive

- **A stolen password no longer changes how the organization works** while the switch is on: keys, people, switches and settings need the phone too.
- **One check, one place.** Every admin route calls the same helper after its role check; approval calls `requireSecondFactor()` itself.
- **Nothing is locked out.** The owner passes it before switching it on, and the override turns it off.

### Negative

- **A session that skipped the code can still read, and change a member's own records, through the API** (GAP-33). The code screen stops the app, not a caller with a token. Admin actions and approving are refused.
- **Enrolling isn't in our audit trail.** Supabase Auth keeps its own log of factor changes; the switch itself is audited as every switch is.
- **Every admin action reads the switch once** for a session at aal1; at aal2 it isn't read.

## Exit path / reversibility

- **The helper is the policy.** Widening it to every request, or narrowing it, changes one function.
- **Removing the flag** keeps the code at sign-in for whoever enrolled and admin actions at aal2 for everyone, once every organization has it on.
- **Another factor** (passkeys, phone) is another Supabase factor type; the API trusts `aal` either way.

## Links

- FR-PLT-03, FR-GOV-04, FR-GOV-01, F-11, GAP-03, GAP-33, Q40, Q41, US-ACC-11, US-ACC-12, #8, #85
- [Runbook: the second factor, and a lost authenticator](../runbooks/environment-setup.md#the-second-factor-totp)
- [Supabase: TOTP multi-factor authentication](https://supabase.com/docs/guides/auth/auth-mfa/totp)
