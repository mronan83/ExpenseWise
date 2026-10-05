# ADR-0044: The second factor holds every request of someone with an authenticator, read from Supabase Auth's own record

While their organization has the second factor on, a session of someone whose sign-in has a verified authenticator, until it passes the code, gets nothing from the API but who they are and the organization's switches. So does a session of another email of theirs with no authenticator of its own, until it adds one and passes it (amended for #88). Linking another sign-in needs the code from anyone with an authenticator, whatever the switch. The API learns who has one from Supabase Auth's own record of factors, through owner-run functions that answer yes or no, as each request finds its caller.

- **Status:** Accepted (every request held until the code, and linking a sign-in needing it, decided by product owner, Oct 5, Q41; a person's other emails held until each adds its own authenticator decided by product owner, Oct 5, Q43; reading Supabase Auth's record through one function, the two routes left open before the code, the linking rule applying whatever the switch, and how an email held for its own authenticator is asked and told, recommended, no objection yet; whether a held email's new authenticator needs confirming is Q44)
- **Date:** 2026-10-05
- **Deciders:** Product owner (Q41, Q43); Claude (principal architect), for the design
- **Decision register:** D-46. Amends [ADR-0042](0042-second-factor.md), whose admin-only reach and GAP-33 it ends; builds on [ADR-0013](0013-supabase-platform.md) (Supabase Auth, our API for data), [ADR-0016](0016-several-sign-ins-per-person.md) (several sign-ins for one person) and [ADR-0035](0035-own-records-and-invite-links.md) (each request resolves its caller); closes GAP-33 (#85) and, amended, GAP-35 (#88).

## Context

ADR-0042 asks for the code at sign-in in the app, and the API refuses admin actions and approving without it. A token from a password alone, used against the API directly, still read that person's records, changed their own and could link another sign-in (GAP-33). The product owner answered Q41: refuse every request of someone with an authenticator until they enter the code, and need it to link a sign-in.

A token says whether its session passed the code (`aal`), not whether its person has an authenticator. The app asks Supabase Auth in the browser (the session's next level is aal2 when a verified factor exists); the API needs the same fact. Five things shape how it gets it:

- **Supabase Auth keeps the factors** in `auth.mfa_factors`, one row per factor with its user and whether it is verified. People add and remove them from the browser straight to Supabase Auth; our API never sees it happen. Removing a verified one needs a session that passed the code, and the owner removes a lost one in Supabase's dashboard (the runbook).
- **The runtime connects as `expensewise_app`**, which can't bypass row-level security and holds no right on Supabase's `auth` schema; never as Supabase's `postgres` (CLAUDE.md). The schema owner, which runs the migrations and owns our definer functions, can read `auth.mfa_factors` on Supabase.
- **Tests and local development run on plain Postgres**, with no `auth` schema at all.
- **Every route already resolves its caller** through the workspace store, which records them for row-level security (ADR-0035); a store refuses to read a member's records without it.
- **A person may sign in with several emails** (ADR-0016). Each is its own Supabase Auth user, with its own authenticators and its own `aal`.

## Decision

1. **Supabase Auth's record, through one function.** Migration 0048 adds `sign_in_has_authenticator(user_id)`: whether that Supabase Auth user has a verified factor, any kind, as Supabase's own next level counts it, and nothing else: no factor's id, name, type or secret. It runs as the schema owner (SECURITY DEFINER), and only `expensewise_app` may call it. A user id that isn't a UUID isn't a Supabase Auth user, and plain Postgres has no Supabase Auth: both answer no. The migration reads `auth.mfa_factors` once when it exists, so a release whose schema owner couldn't read it fails there, not on every request. The API asks it in the same query that finds the caller's membership (`findSignedInMember`), so it costs no round trip.
2. **Once, as each request finds its caller.** Resolving the caller now admits them first: while the organization has the second factor on (the server's override first), a session at aal1 of someone whose sign-in has an authenticator is refused with 403 `second_factor_required` before anything of the organization is read or changed. The switch is read only in that case. No route can forget it; the two invite routes, which never needed a membership, now resolve it too. A test walks every operation in the contract.
3. **Open before the code: who they are, and the switches.** `GET /v1/me` names the signed-in user and nothing of an organization. `GET /v1/features` gives the organization's switches, which the code screen and the check in front of everything read to send someone there. Signing out is Supabase Auth's alone. Everything else is held, `POST /v1/me/organization` and Settings › Sign-ins among them. The health checks and the email webhook carry no person's token.
4. **Linking a sign-in needs the code, whatever the switch.** It adds a way in, so from someone with an authenticator it needs a session that passed it, even while the switch, or the server's override, is off. The app asks for the code where it asks for any, then links. Someone with none links as before, with proof of both sign-ins (FR-PLT-04).
5. **Someone with no authenticator is not asked**, as their session can't pass a code they don't have; admin actions still ask them to add one (ADR-0042). With the switch off, nothing changes for anyone, but point 4.
6. **Each sign-in by its own authenticators.** The code is asked of the token's own Supabase Auth user, as Supabase decides `aal`, so the API asks for a code exactly when the app sends the session to the code screen: never of one that has no code to enter. A person's other email with no authenticator of its own is held another way, until it adds one (see *A person's other emails*, below).
7. **In the app,** a read refused this way asks for the code with the same prompt as an admin action, and carries on once it is in; a download does too. The prompt never opens over the code screen, and gives way to it when a page's first reads were refused just before the session was sent there, so the code is asked once.

## A person's other emails (#88, Q43)

The product owner answered Q43 on Oct 5: hold a person's other email until it adds its own authenticator and enters its code, the app saying which email needs one.

8. **Held until it adds its own.** While the organization has the second factor on (the server's override first), a session of an email with no verified authenticator of its own, of a person who has one on another email they sign in with, is refused on every request with 403 `authenticator_required` before anything of the organization is read or changed. The problem document names the email (`email`, and in its `detail`), so the app can say which one needs it. It is held whatever its session says: a token can still read aal2 for a while after its own last authenticator is removed, and what counts is whether the email has one now. Once it adds one in Supabase Auth and enters its code, its session reaches aal2 and passes; from then on it is an email with an authenticator, asked for its own code as in point 2. Off, nothing changes, linking included (point 4 asks only of an email with its own authenticator).
9. **One more function, over the person's sign-ins.** Migration 0050 adds `person_has_authenticator(user_id)`: whether any sign-in of the member this sign-in belongs to, this one or another, has a verified factor, as `sign_in_has_authenticator` answers for each. Yes or no, and nothing else: not which email has one, how many, or any email. It reads Supabase's record only through the first function, so what counts as a verified factor is decided in one place and no right on Supabase's `auth` schema is added; it runs as the schema owner because, before an organization is chosen, the app sees only the token's own sign-in (`own_sign_ins`), and only `expensewise_app` may call it. A sign-in no member has, and plain Postgres, answer no. The API asks it in the same query that finds the caller, beside the first, so it still costs no round trip; the switch is read only for an email held this way.
10. **The same two requests stay open.** Who is signed in (`GET /v1/me`) and the switches (`GET /v1/features`): Settings › Sign-ins adds an authenticator through Supabase Auth in the browser and reads only the switches from us, so the list is the code screen's, unchanged. The held email's own Settings › Sign-ins doesn't list the person's other emails.
11. **In the app,** a refusal this way never opens the code prompt, as there is no code to enter. A screen of its own, the only thing on screen like the prompt, says in plain words that this email, named, needs its own authenticator, with a button to Settings › Sign-ins and a way to sign out. Settings › Sign-ins says the same and offers adding one there, and opens the rest once its code is in.
12. **No lockout.** A held email can always add its own with its password alone, which is what Supabase allows an email with none. If a person's only authenticator is removed, by them or by the owner in Supabase for a lost phone, their other emails are free again on the next request; nothing of ours needs clearing, and the server's override turns all of it off (the runbook).

The hold stops a stolen password used as it is. It can't tell the person adding an authenticator from someone else holding that email's password, who could add theirs and get past it: GAP-36, asked as Q44 (#90 would have the person confirm a held email's new authenticator from an email whose code they entered).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A record of our own, set when someone passes the code and cleared when they remove their last authenticator | Two records of one fact, which drift. Removing happens in the browser or Supabase's dashboard, never through our API, so ours would still say yes after the last one goes, and every later session, at aal1, would be refused: a lockout the runbook can't undo in Supabase alone. Clearing it from an aal1 session would let a stolen password clear it; clearing it beforehand from aal2 races the removal. And someone who adds one is unprotected until their first request at aal2. |
| Grant `expensewise_app` SELECT on `auth.mfa_factors` | The app would read every factor's secret, name and type, and depend on Supabase's grants on its own schema. |
| Ask Supabase Auth's admin API per request | A call to another service inline in a request, with the service key in the runtime (CLAUDE.md, ADR-0013). |
| Check every request in a middleware ahead of the routes | It knows no organization, so it would find the caller's membership a second time on every request. Finding the caller is where the organization, and so its switch, becomes known. |
| Hold a person's every sign-in with `second_factor_required` once any of them has an authenticator | The other sign-in can't pass a code until it adds its own, and the app, asking Supabase for that session, wouldn't send it to the code screen: every screen would be refused with nothing to enter. Asked as Q43; built with its own refusal, `authenticator_required`, that says which email needs one instead (point 8). |
| For a person's other emails, extend `sign_in_has_authenticator` to answer for the person | It answers for a sign-in, as Supabase decides `aal`, and the code is asked by it (point 6); answering for the person would ask the held email for a code it can't have. A second function keeps both facts, each yes or no. |
| Let a held email read its sign-ins and `POST /v1/me/organization`, so Settings › Sign-ins loads as it is | Adding an authenticator needs neither; the list of open requests would grow for a page, and a password alone would see the person's other emails. |
| Leave the linking rule to the switch | A password alone, while the switch is off, could still add an email it controls to someone with an authenticator, ready for the day it is switched on. |

## Consequences

### Positive

- **A stolen password opens nothing** of an organization with the second factor on, for someone with an authenticator, through the app or the API.
- **Removing an authenticator takes effect on the next request**, by its person or by the owner for a lost one: nothing of ours to clear, and no lockout the runbook doesn't already undo.
- **One check, one place, no extra query.** It rides on finding the caller.

### Negative

- **The API reads a Supabase Auth table** through a definer function that depends on two of its columns (`user_id`, `status`). Supabase's own documentation reads them the same way for multi-factor policies; a release whose owner can't read them fails at the migration.
- **On plain Postgres, no one has an authenticator**, so the integration tests stand in for `auth.mfa_factors` where they need one, and the bench, which has none, never holds a request this way; its screens stand in for the refusals.
- **Whoever has a held email's password** can add an authenticator to it and get past the hold (GAP-36, Q44).

## Exit path / reversibility

- **The admit step is the policy.** Narrowing it back to admin actions is one line in `app.ts`; the function stays harmless. Letting a person's other emails go again (Q43 B) is one line in `secondFactorEverywhere`, and `person_has_authenticator` stays harmless too.
- **Another factor kind** (passkeys, phone) counts already: the function asks for any verified factor.
- **If Supabase moves its factors**, only the function changes.

## Links

- FR-PLT-03, FR-PLT-04, FR-GOV-04, F-11, GAP-33, GAP-35, GAP-36, Q41, Q43, Q44, US-ACC-13, US-ACC-14, #85, #88, #90
- [ADR-0042](0042-second-factor.md), [Runbook: the second factor](../runbooks/environment-setup.md#the-second-factor-totp)
- [Supabase: enforce MFA for users who have it](https://supabase.com/docs/guides/auth/auth-mfa#enforce-rules-for-mfa-logins)
