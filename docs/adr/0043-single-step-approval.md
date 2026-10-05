# ADR-0043: A closed report goes to one approver, who approves it or returns it; the database keeps who decides what

A person submits their own closed report. It goes in one step to one approver, who approves it or returns it with a comment, rejecting expenses with why; an expense that differs from its receipt is rejected on its own, and any rejection returns the whole report. A one-person organization's owner self-attests. Approving someone else's spend needs the second factor. Submitting copies each expense's category and type names onto it. The database shows an approver what is routed to them, lets whoever decides change only the report's and its expenses' status, and locks an approved expense.

- **Status:** Accepted (one step, approve or return with a comment, self-attestation alone and separation of duties in a team from the blueprint, journeys §4.4 and ADR-0001; matching the receipt, one rejection returning the report and rejections surfaced decided by product owner, Oct 3 and Q6; export of submitted and approved reports decided by product owner, Q29; the second factor with approval decided by product owner, Q40; who a report goes to, kept as built, and an owner choosing each member's approver in Settings › People decided by product owner, Q42 (#86); deciding in an approver's place, the week a returned report gets, not asking for the second factor to return one, a submitted report keeping the approver it went to, and the database rules recommended, no objection yet)
- **Date:** 2026-10-05
- **Deciders:** Product owner (Oct 3, Q6, Q29, Q40, Q42); Claude (principal architect), for the design
- **Decision register:** D-45. Builds on [ADR-0029](0029-expense-reports.md), whose submission it adds, and [ADR-0035](0035-own-records-and-invite-links.md), whose point 4 it completes; closes GAP-27 (#70).

## Context

Reports open, close within 28 days and can be reopened until submitted (ADR-0029), but nothing submitted them. The product owner's rules for approval (#24):

- **One step.** Every report goes to its approver, who approves it or returns it with a comment (FR-GOV-02).
- **Separation of duties.** In a team no one approves their own spend; alone, the owner self-attests and the audit event says so (FR-GOV-03, `canApprove`, ADR-0001).
- **The second factor.** Approving someone else's spend needs it in this session (FR-GOV-04); Q40 builds it in the same batch, behind its own switch (#8).
- **The receipt.** An expense may claim less than its receipt with a reason, never more (FR-EXP-10); a report can't be submitted while one differs without a reason, and the difference shows as soon as it is edited (FR-GOV-13); at review, one that differs is rejected (FR-GOV-10), one rejection returns the whole report (FR-GOV-11), and rejected expenses are surfaced with why, on the report and in Needs you (FR-GOV-12).
- **Export.** Once approval exists, submitted and approved reports are exported (Q29).
- **Names.** Renaming a category changed it on old claims (GAP-27, NFR-DAT-04).

ADR-0035 lets a member change only their own records, and an approver see only their own. Approving changes someone else's report and expenses, and the approver has to see them.

## Decision

1. **Submitting.**
   - Only the person's own closed report is submitted; closing never submits, and day 28 closes but never submits (ADR-0029). With approval off nothing changes: no report is submitted, and a closed one exports as before.
   - It is refused while an expense on it differs from its receipt without a reason, naming each. Merchant (loosely), date and currency must be the receipt's; the amount the receipt's, or lower with a reason: the person's own words, up to 500 characters (R-APPROVAL-NOTE-MAX), or lines left out, each with its reason (FR-EXP-16). A drive, or an expense typed in, has nothing to differ from. A split is one expense with one receipt (Q35), its parts adding up to its claim. With approval on, an edit above the receipt's total is refused, and the expense says how it holds up as soon as it is saved.
   - Each expense on it is submitted, and its category's and type's names, and its parts', are copied onto it (#70). Reports and exports read those while it is submitted; returned, it reads the names as they are until it goes again.
   - A trip on a submitted report takes no more expenses: a late one dated in it files as local, for the next report.
2. **Who it goes to.** One step, to one approver chosen at submission (`routeReport`):
   - in a one-person organization, its owner, who self-attests;
   - in a team, the approver an owner chose for the member in Settings › People while they can approve it; otherwise, or on Automatic, the longest-standing approver, then finance admin, then owner; never the member;
   - when no one else can approve it, submitting is refused, and it stays closed.
   - **Choosing** (#86, Q42, behind approval). Only an owner chooses, from everyone else active whose role may approve (`mayChooseApprover`), or Automatic; it is an admin action, so it needs the second factor while that is on, and each change is audited (`member.approver_chosen`, from and to). The choice is kept in `members.manager_member_id`, a member of the same organization by a composite key and never the member themselves (`members_manager_not_self`).
   - **When the one chosen can't approve.** Their role changed, or they were removed: the choice stays, routing passes over them and finds one as Automatic does, and People says so; given an approving role again, they are the one again.
   - **Already submitted.** A report keeps the approver its step names; a new choice routes only reports submitted afterwards.
3. **Deciding.**
   - The approver it went to decides, or an owner or finance admin in their place, so a report never waits on someone who left; always within `canApprove`. The step records who decided.
   - Approving someone else's needs the second factor (`requireSecondFactor`); self-attesting doesn't, and returning doesn't, since it pays nothing.
   - Review checks each expense against its receipt as it is then. One that differs is rejected on its own, with why, and the report can only be returned.
   - A return needs a comment; the approver may reject expenses, each with why. The whole report goes back, open again with its day 28 or a week from the return if later (R-REOPEN-GRACE), its expenses Ready again. Rejections are kept per round in `expense_rejections`; the report and Needs you show the latest round's, with the comment, until the report is submitted again.
   - Approving approves its expenses, which are then locked.
   - Every step is in the audit trail: who submitted, who it went to, who decided on what basis (`separation_of_duties` or `solo_self_attestation`), the comment and each rejection.
4. **What the database keeps.**
   - **Seeing.** An approver sees each report a step names them on, with its trips, expenses and receipts and what hangs off them, through owner-run functions so the policies don't call back into each other.
   - **Deciding.** The decision runs as the person deciding, naming the report it decides for that transaction. The `own_records` trigger then lets them change that report's status and times and its expenses' status, and add its rejections, while its step is pending; nothing else of its member's.
   - **Routing.** Only a report's own member adds its step, and only a pending step is decided, by whoever may decide it or by a one-person organization's owner on their own.
   - **Locking.** An approved expense is changed by nothing but settling it, whoever asks.
   - A report that has been through approval is never dropped, even emptied.
5. **Correcting an approved expense** with a reversal and a new version is not built (GAP-34, #87).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Write a decision as the system, after checking it in code | One forgotten check would let anyone change anyone's claim; ADR-0035 put the rule in the database so no route can forget it. |
| Let approvers' role see every report | An approver would see colleagues' spending they never approve. |
| Route to the owner first | The approver role exists to approve; in a team with one, the owner would approve everything. Q42 kept routing by role. |
| Clear a member's chosen approver when that person can no longer approve | The owner would lose the choice to a role change made for another reason, and People could not say what happened; passing them over keeps both. |
| Only the approver it went to decides | A report would wait forever on someone removed, or routed while the organization was one person. |
| Return to closed rather than open | Its expenses need changing, which reopens a closed report anyway (ADR-0029). |
| Ask for the second factor to return a report | Returning pays nothing; asking would stop an approver without a factor from sending a claim back to be fixed. |
| Copy names onto every expense as it is coded | Copies that change with every edit protect nothing; the claim is fixed when it is submitted. |

## Consequences

### Positive

- **The rule holds whatever the code does.** Seeing, deciding and locking are the database's, with an error rather than a silent skip.
- **One-person organizations lose nothing.** Riley submits and self-attests in two taps, without a second factor, and the trail says so.
- **A difference is caught before review.** Most rejections never happen, because submission names them first.

### Negative

- **More functions per row.** Each policy on reports, trips, expenses and receipts asks an owner-run function. Small at this scale.
- **The approver needs the second factor first.** Until #8 is on and enrolled, a team's approver can return reports but not approve them.
- **No correction yet.** An approved mistake stays approved until #87.
- **Rejections leave Needs you only on resubmission**, even once fixed.

## Exit path / reversibility

- **Routing** is one domain function, `routeReport`, whose first rule is the approver chosen per member (#86); dropping the choice is clearing one column.
- **Several steps** (Phase 2): the steps are numbered, and the lifecycle already counts remaining steps.
- **The database rules** are one migration's functions and policies, replaced together.

## Links

- FR-GOV-02, FR-GOV-03, FR-GOV-04, FR-GOV-10 to FR-GOV-13, FR-EXP-10, FR-EXP-03, NFR-DAT-04, FR-SET-01, F-18, Q6, Q29, Q40, Q42, GAP-27, GAP-34, backlog #24, #70, #86, #87, #8
- [ADR-0001](0001-target-segment-and-tenancy.md), [ADR-0029](0029-expense-reports.md), [ADR-0035](0035-own-records-and-invite-links.md), [ADR-0041](0041-itemized-lines-splits-and-exclusions.md)
