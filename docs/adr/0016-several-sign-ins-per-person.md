# ADR-0016: One person, several sign-ins

A member can sign in with more than one email. Each sign-in reaches the same member, so the product sees one person, not a team.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-18
- **Related:** [ADR-0001](0001-target-segment-and-tenancy.md) (tenancy and separation of duties), [ADR-0013](0013-supabase-platform.md) (Supabase Auth), [ADR-0015](0015-ai-provider-keys-in-app.md) (sign-in brought forward)

## Context

The product owner signs in with two emails, a personal and a work address. Both must reach the same receipts. Supabase Auth gives each email its own user. Until now a member had exactly one user (`members.user_id`), and each new user's first sign-in created a new one-person organization.

There are two ways to share receipts between the emails:

- **Two members of one organization.** ADR-0001 applies separation of duties whenever an organization has two or more members. The product owner would become a team of two: unable to approve their own reports, with one email approving the other's expenses. The audit trail would record a second approver who is the same person, which is false.
- **One member with two sign-ins.** The product sees one person. A one-person organization still self-attests its approvals, which is what actually happens.

## Decision

1. **Sign-ins are separate from members.** The new tenant table `member_sign_ins` maps an identity-provider user to a member. A member has one or more sign-ins. Each sign-in belongs to exactly one member, so `user_id` is unique across all organizations in Phase 1. The API resolves the caller through this table. `members.user_id` now records only the member's first sign-in, and a later release drops it (expand and contract).
2. **Linking needs proof of both sign-ins.** A signed-in member adds a sign-in by entering its email and password on **Settings → Sign-ins**. The browser signs in to that account in a throwaway session and sends its access token to `POST /v1/me/sign-ins`. That token must be valid and issued within the last 10 minutes. The request's own token proves the first sign-in. The second token is used once and never stored. Nothing relies on an email address matching, so an unverified or reused address can't take over a member.
3. **A sign-in that already made an empty organization moves.** If the other email signed in before and so created its own organization, linking moves it, but only when that organization has one member, one sign-in and no work: no receipts, expenses, trips, mileage, reports, categories or AI keys. Its history stays and records the move. Otherwise the API refuses and nothing changes, and the screen suggests linking in the other direction.
4. **Removing.** Any sign-in except the one making the request can be removed. A member is never left with no sign-in.
5. **Row-level security.** `member_sign_ins` has the tenant policy plus a read-only `own_sign_ins` policy. The `own_memberships` policy on `members` now shows a user the members they sign in as. Every change is audited in each organization it touches, in one transaction.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Two members in one organization | Turns one person into a team: separation of duties blocks self-approval, and the audit trail names a second approver who doesn't exist. |
| Supabase identity linking (one auth user with several identities) | Supabase links OAuth identities to a user, but not a second email and password. It would also tie the person model to one vendor's auth (R9). |
| Link by matching email: pre-register the second address, attach whoever signs in with it | It trusts the token's email claim. If public sign-ups were ever turned on without confirmation, someone could claim a pending address. Proving control of both accounts avoids this. |
| One shared email for both | It doesn't meet the need: the owner wants to use whichever address they're signed in with. |

## Consequences

### Positive

- One person stays one person for approvals, audit and reporting, whichever email they sign in with.
- Invitations in increment 4 reuse the same table: an invite adds a member and its first sign-in.
- Linking works in either order. A second email that signed in first and created an empty organization is moved, so nobody has to clean up by hand.

### Negative

- **A moved sign-in leaves an empty organization behind.** It keeps only its creation and move events. Contained by the emptiness check. A later clean-up can archive such organizations.
- **Linking asks for the other account's password in this app.** It goes straight to Supabase from the browser, never to our API. Contained by the throwaway, non-persisted session, which is signed out right after.
- **`members.user_id` is stale for linked members until it is dropped.** Nothing reads it for access any more.

## Exit path / reversibility

Removing a sign-in undoes a link. Moving to several organizations per sign-in later means dropping the unique constraint on `member_sign_ins.user_id` and adding organization choice. Dropping the feature means deleting the extra sign-ins.

## Links

- [ADR-0001](0001-target-segment-and-tenancy.md), [ADR-0013](0013-supabase-platform.md), [ADR-0015](0015-ai-provider-keys-in-app.md)
- Migrations `0006_member_sign_ins.sql` and `0007_member_sign_ins_rls.sql`
