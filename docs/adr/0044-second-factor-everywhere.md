# ADR-0044: The second factor holds every request of someone with an authenticator, read from Supabase Auth's own record

While their organization has the second factor on, a session of someone whose sign-in has a verified authenticator, until it passes the code, gets nothing from the API but who they are and the organization's switches. Linking another sign-in needs the code from anyone with an authenticator, whatever the switch. The API learns who has one from Supabase Auth's own record of factors, through one function that answers yes or no, as each request finds its caller.

- **Status:** Accepted (every request held until the code, and linking a sign-in needing it, decided by product owner, Oct 5, Q41; reading Supabase Auth's record through one function, the two routes left open before the code, the linking rule applying whatever the switch, and holding each sign-in by its own authenticators recommended, no objection yet; whether a person's other sign-ins must add their own is Q43)
- **Date:** 2026-10-05
- **Deciders:** Product owner (Q41); Claude (principal architect), for the design
- **Decision register:** D-46. Amends [ADR-0042](0042-second-factor.md), whose admin-only reach and GAP-33 it ends; builds on [ADR-0013](0013-supabase-platform.md) (Supabase Auth, our API for data), [ADR-0016](0016-several-sign-ins-per-person.md) (several sign-ins for one person) and [ADR-0035](0035-own-records-and-invite-links.md) (each request resolves its caller); closes GAP-33 (#85).

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
6. **Each sign-in by its own authenticators.** The question is asked of the token's own Supabase Auth user, as Supabase decides `aal`, so the API holds exactly the sessions the app sends to the code screen: never one that has no code to enter, never one the app lets through. A person's other email with no authenticator of its own still opens on its password; whether it should add one first is Q43 (GAP-35, #88).
7. **In the app,** a read refused this way asks for the code with the same prompt as an admin action, and carries on once it is in; a download does too. The prompt never opens over the code screen, and gives way to it when a page's first reads were refused just before the session was sent there, so the code is asked once.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A record of our own, set when someone passes the code and cleared when they remove their last authenticator | Two records of one fact, which drift. Removing happens in the browser or Supabase's dashboard, never through our API, so ours would still say yes after the last one goes, and every later session, at aal1, would be refused: a lockout the runbook can't undo in Supabase alone. Clearing it from an aal1 session would let a stolen password clear it; clearing it beforehand from aal2 races the removal. And someone who adds one is unprotected until their first request at aal2. |
| Grant `expensewise_app` SELECT on `auth.mfa_factors` | The app would read every factor's secret, name and type, and depend on Supabase's grants on its own schema. |
| Ask Supabase Auth's admin API per request | A call to another service inline in a request, with the service key in the runtime (CLAUDE.md, ADR-0013). |
| Check every request in a middleware ahead of the routes | It knows no organization, so it would find the caller's membership a second time on every request. Finding the caller is where the organization, and so its switch, becomes known. |
| Hold a person's every sign-in once any of them has an authenticator | The other sign-in can't pass a code until it adds its own, and the app, asking Supabase for that session, wouldn't send it to the code screen: every screen would be refused with nothing to enter. Asked as Q43 instead. |
| Leave the linking rule to the switch | A password alone, while the switch is off, could still add an email it controls to someone with an authenticator, ready for the day it is switched on. |

## Consequences

### Positive

- **A stolen password opens nothing** of an organization with the second factor on, for someone with an authenticator, through the app or the API.
- **Removing an authenticator takes effect on the next request**, by its person or by the owner for a lost one: nothing of ours to clear, and no lockout the runbook doesn't already undo.
- **One check, one place, no extra query.** It rides on finding the caller.

### Negative

- **The API reads a Supabase Auth table** through a definer function that depends on two of its columns (`user_id`, `status`). Supabase's own documentation reads them the same way for multi-factor policies; a release whose owner can't read them fails at the migration.
- **On plain Postgres, no one has an authenticator**, so the integration tests stand in for `auth.mfa_factors` where they need one, and the bench, which has none, never holds a request this way.
- **A person's other email with no authenticator** still opens on its password (Q43).

## Exit path / reversibility

- **The admit step is the policy.** Narrowing it back to admin actions is one line in `app.ts`; the function stays harmless.
- **Another factor kind** (passkeys, phone) counts already: the function asks for any verified factor.
- **If Supabase moves its factors**, only the function changes.

## Links

- FR-PLT-03, FR-PLT-04, FR-GOV-04, F-11, GAP-33, GAP-35, Q41, Q43, US-ACC-13, #85, #88
- [ADR-0042](0042-second-factor.md), [Runbook: the second factor](../runbooks/environment-setup.md#the-second-factor-totp)
- [Supabase: enforce MFA for users who have it](https://supabase.com/docs/guides/auth/auth-mfa#enforce-rules-for-mfa-logins)
