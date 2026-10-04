# ADR-0035: Each member's records are kept to them in the database, and people join by invite link

Inside an organization, Postgres keeps each member to their own receipts, expenses, trips and reports, using the caller's membership that every request names; owners, finance admins and auditors see everyone's, everyone changes only their own, and an auditor changes nothing. People join by a one-time link an owner makes in Settings › People, with no email sent.

- **Status:** Accepted (adding #50 and inviting by link decided by product owner, Oct 4; enforcing it in the database, and what owners, finance admins and auditors may do, recommended, with Q34 open)
- **Date:** 2026-10-04
- **Deciders:** Product owner ("Add #50; invite by link", Oct 4); Claude (principal architect), for the design
- **Decision register:** D-37. Closes GAP-20 (#50) and builds #29; extends [ADR-0001](0001-target-segment-and-tenancy.md)'s tenant isolation inside one organization and follows [ADR-0016](0016-several-sign-ins-per-person.md) for an empty organization of one's own.

## Context

Row-level security keeps organizations apart, but inside one the API checked only that the caller was a member (GAP-20). Harmless while every organization had one person; the first invite would have shown a new member their colleagues' spending. FR-GOV-01 names five roles and a read-only auditor. The product owner asked on Oct 4 for #50 before invites, and for invites by link rather than email, so email notifications (#27) aren't needed.

Seven other changes were being written against `withOrg(db, orgId, fn)` at the same time, and every workflow calls it without any person in mind.

## Decision

1. **The database enforces it.** `withOrg()` takes an optional `member` (`withMember()` is the same with a membership), and sets `app.member_id` and `app.member_role` beside `app.org_id`, for the transaction only.
   - **Reads:** a restrictive `own_records` policy on receipts, expenses, trips, reports and inbound emails shows a member or approver only rows whose `member_id` is theirs; readings, confirmations, duplicate pairs and mileage are seen with their receipt or expense; approval steps by their approver and with their report. Owners, finance admins and auditors see everyone's.
   - **Writes:** an `own_records` trigger on the same tables refuses an insert, update or delete of a row that isn't the acting member's own, and any change at all by an auditor, with an error. A trigger rather than a policy because row-level security skips a refused update silently, and the code would then write an audit event for a change that never happened.
   - **No member named means the system.** Workflows, the release's data steps and the people store name no member and see and change every member's records, as before, so their code and `withOrg(db, orgId, fn)` are unchanged. `switchOrg()` also drops the member, since it serves the system.
2. **The API names the caller for every member-facing store.** Each request gets a slot (AsyncLocalStorage); resolving the caller through the workspace store fills it, so no route can forget; and the receipt, expense, trip, report and Home stores run their transactions as that member through one helper, `asCaller()`, which refuses to run without one rather than act for the system. A refusal from the database answers 403 `not_yours`.
3. **What each role does.** A member or approver sees and changes their own. Owners and finance admins see everyone's and change their own. An auditor reads everyone's and changes nothing, not even a receipt of their own. Receipts, Expenses and Trips list the caller's own for every role, as Home, Needs you and Reports already did; seeing a colleague's record is by its link. Whether owners and finance admins should also change others' records, or get a list of everyone's, is Q34.
4. **Approvers, today.** Nothing routes a report to an approver until approval (#24), so an approver sees only their own records. The approval-step policy already shows a step to its approver; #24 adds the report it names.
5. **One file is claimed once.** The same file filed by a colleague is refused, without the colleague's receipt being shown: the organization-wide unique key catches it.
6. **Invites by link** (#29, behind `team.invites`). An owner makes a link with a role in Settings › People. Its token is 32 random bytes; only its SHA-256 is stored. It works once, for 7 days, until revoked. Before joining, the person holding it sees only that invite (`invite_holder`, through `app.invite_hash`). Accepting needs a signed-in account: sign-ups stay off (D-15), so the owner makes the account in Supabase first, and both screens say so. An empty one-person organization the person's first sign-in made is left behind, as linking a sign-in does (ADR-0016); one with work, invites or other people in it is refused and nothing changes.
7. **People.** Only owners manage people. An owner changes a role and removes someone: the member is deactivated, their sign-ins go, and their records and history stay; invited again, they come back as the same member. The last owner can't be demoted or removed, and no owner removes themselves. Every step is audited. Separation of duties stays `canApprove`, which counts active members.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Check ownership in each API route | Every route, today's and the seven being written, would have to remember; one that forgot would leak silently. |
| Row-level security for writes too | A refused update is skipped without an error, so a change an owner can see but not make would still write its audit event. |
| Make `withOrg()` refuse to run without a member | Every workflow and the other changes in flight call it without one. The member-facing stores refuse instead. |
| Owners and finance admins change everyone's records | Lets a claim change under its claimant. Least privilege until approval gives a way to send a claim back; asked as Q34. |
| Invite by email | Needs a sender domain and email notifications (#27). The product owner chose links. |
| Keep the token in the URL path of the API | Paths reach logs; the API takes it in the body. Only the page's own address carries it. |

## Consequences

### Positive

- **A forgotten check can't leak.** The database answers for every query a member's request makes, and a test fails when a table with a `member_id` has no policy and trigger.
- **Nothing changes alone.** In a one-person organization the owner sees and changes everything, as before; background work is untouched.
- **Joining costs no email setup**, and nothing about the link is stored that would let someone use it.

### Negative

- **Two settings per transaction** and a function call per row checked. Small at this scale; the per-row parent lookups for readings and pairs ride on unique keys.
- **The audit trail and outbox stay organization-wide** for every member's transaction, because each member chains the next audit event. No operation shows them; GAP-34 (#77).
- **An owner opening a colleague's record sees actions that the server refuses** (403), until the screens hide them or Q34 changes what owners may do.
- **A link works for whoever holds it** for 7 days. The owner sends it to one person and can revoke it; it works once.

## Exit path / reversibility

- **The member is optional.** Dropping it from the stores returns to organization-wide access with no migration; dropping the policies and triggers is one migration.
- **Changing a role's powers** is two SQL functions (`app_sees_every_member`, `app_changes_member`) and their domain twins (`seesEveryMember`, `mayChangeRecord`).
- **Email invites later** can deliver the same link; the token, hash and acceptance stay.

## Links

- GAP-20, GAP-34, Q34, FR-GOV-01, FR-PLT-07, F-23, F-61, backlog #50, #29, #24, #27, #77
- [ADR-0001](0001-target-segment-and-tenancy.md), [ADR-0016](0016-several-sign-ins-per-person.md), [ADR-0032](0032-features-switched-per-organization.md)
