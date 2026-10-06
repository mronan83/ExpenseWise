# ADR-0045: What the company pays directly is kept on the trip by a policy by type, and never claimed

An expense the company paid directly, such as airfare an employer books, is marked on the expense: by the organization's policy for its type, which owners and finance admins keep in Settings › Organization, or by hand, which the policy then leaves alone. It stays on its trip and its report, in the trip's cost, and out of every claim: listed apart, below the claim and outside its total, in the report and its CSV and PDF.

- **Status:** Accepted (a policy by type with a switch on each expense decided by product owner, Oct 6, Q46; listed apart on the report and its export, below the claim and outside its total, decided by product owner, Oct 6, Q47; a change of the policy reaching every expense not yet on a submitted report except one switched by hand decided by product owner, Oct 6, Q48; the columns and the pin, the policy applying when a person gives an expense its type, the policy as an admin action under the second factor, the policy running for the system, a closed report reopening, drives never paid by the company, the CSV's Paid by column and the export's wording recommended, no objection yet)
- **Date:** 2026-10-06
- **Deciders:** Product owner (Q46, Q47, Q48); Claude (principal architect), for the design
- **Decision register:** D-47. Builds on [ADR-0023](0023-expenses-file-to-trips-by-date.md) (a person's choice pins, as `trip_pinned` does), [ADR-0029](0029-expense-reports.md) (a change reopens a closed report), [ADR-0035](0035-own-records-and-invite-links.md) (each person changes only their own), [ADR-0036](0036-categories-and-types.md) (types, where rules attach) and [ADR-0032](0032-features-switched-per-organization.md) (behind `expenses.company-paid`). Delivers FR-EXP-17, FR-EXP-18 and F-62 (#95).

## Context

The product owner's employer books and pays airfare directly, not on the company card. They want each trip's full cost in ExpenseWise, the airfare tracked on the trip but never claimed, and a policy they change when their employer or its policy changes (Oct 6). Until now everything on a report was claimed; the nearest thing, leaving out a receipt's line as Paid by someone else (FR-EXP-16), claims nothing for it but still lists it inside the claim.

What shapes the design:

- **Types are where rules attach** (ADR-0036, Q7). Airfare is a ready-made type, and a person chooses each expense's type; a suggestion is never stored.
- **A person's choice already outranks a rule elsewhere.** A trip a person chose for an expense is pinned, and filing by date leaves it there (ADR-0023).
- **Each person changes only their own records** (ADR-0035): owners and finance admins see everyone's but change their own. A policy change reaches every member's expenses of the type.
- **A submitted report never changes**, and an approved expense is locked by the database (ADR-0043). Any change to a closed report reopens it (ADR-0029).
- **Every place that totals a claim** reads the report's contents: the report and its list, Home's reports, Needs you, approval lists, the totals in the reimbursement currency (FR-EXP-13) and the export (FR-SET-01).

## Decision

1. **Who paid is two columns on the expense.** `company_paid` says the company paid it directly; `company_paid_pinned` says a person set that by hand. The policy is one column on the type, `company_pays`, for that type only, not those under it. None is set until someone says so.
2. **The policy decides unless a person did** (Q46).
   - When a person gives an expense its type, an expense not set by hand takes the policy for the new type; with no type, the person paid. A suggested type decides nothing until it is confirmed, as a suggestion is never stored.
   - A person sets who paid one of their own expenses either way, and it is pinned; handing it back to the policy clears the pin and applies the policy at once. Each change is one audit event, `expense.paid_by_set`, with before and after.
   - Only before the expense is submitted: after, it is refused with 409 `locked`. A drive is paid at miles × its rate to whoever drove, so it is never paid by the company: a check on the expense holds it, and the switch is refused with 409 `mileage`.
3. **Changing the policy is an admin action** (FR-GOV-04): owners and finance admins, past the second factor while it is on, in Settings › Organization. In the same transaction every expense of the type not set by hand, not a drive and not yet submitted follows it (Q48); a submitted, approved or settled one never changes. It changes members' records the actor doesn't own, so after the API has checked the role it runs for the system, as workflows do (ADR-0035). One audit event, `expense_type.company_pays_changed`, names the type, before and after, and every expense that switched. A closed report one of them is on reopens, as for any change (ADR-0029).
4. **Off, nothing reads it.** Behind `expenses.company-paid`: its two routes answer 404 `feature_off`, and every view, total and export reads as before. The columns are kept whatever the switch, so switching it on shows the expenses as the policy and people left them.
5. **On, what the company paid is never claimed** (FR-EXP-17, Q47).
   - A report's totals, Home's and Needs you's reports, approval lists and the totals in the reimbursement currency leave it out. The report lists it apart, below the claim and outside its total, with its totals and the full cost per currency, the claim and what the company paid together, never converted.
   - A trip's cost is in full and split into claimed and paid by the company, per currency.
   - The export lists it after the claim's totals: the CSV writes a row for each with its own total and the full cost, and a Paid by column, You or The company, on every row, so a sum of the claim can leave it out; the PDF has a section, Paid by the company, not claimed, with the same. A report with nothing the company paid exports as before.
   - It is still on the report, so it must be Ready, and a local one justified, before the report closes or is submitted. An approver sees who paid each expense and rejects one as any other.
   - Home's month figure is what was spent, not a claim, so it keeps everything.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Mark each expense by hand only (Q46 B) | The policy is the employer's and changes as a whole; a person would mark every fare. |
| The policy alone, with no switch on an expense (Q46 C) | A single fare can differ, such as a change fee the person paid themselves. |
| Leave what the company paid off the report entirely (Q47 A) | The product owner chose to list it apart, so whoever reads the report sees the trip's full cost. |
| Only expenses filed after a change follow the policy (Q48 B) | A new employer or policy usually applies to trips not yet claimed. |
| A row per expense in a table of its own | Two booleans on the expense keep it with every other fact about it, and every read already has the row. |
| Run the policy change as the caller | The own-records trigger would refuse every colleague's expense; the role is checked in the API first. |
| Apply the policy to a type's sub-types too | A type's children are often bought otherwise; each type says so for itself. |

## Consequences

### Positive

- **A new employer or policy is one change**, and every unsubmitted expense follows it, with one audit event that names each.
- **The trip shows what it really cost**, and the claim stays exactly what the person paid.
- **Every total reads one split**, worked out by one domain rule in integer minor units.

### Negative

- **Two more reads per report shown**: what is on it by who paid, and what the company paid. Both ride on existing indexes.
- **A policy change runs for the system.** The API's role and second-factor checks are what stand between a member and it.
- **The export gains a column and rows** for a report with something the company paid; a spreadsheet summing the Amount column must filter on Paid by, which the column makes possible.

## Exit path / reversibility

- **The columns are additive.** Switching the feature off hides them; dropping them is one migration, after the flag and its off branch go.
- **The split is one domain function** (`splitCost`) and one view helper per surface; a richer policy, such as by category or by merchant, replaces `companyPaysType()` without changing what reads `company_paid`.

## Links

- FR-EXP-17, FR-EXP-18, F-62, US-RPT-22, Q46, Q47, Q48, backlog #95
- [ADR-0023](0023-expenses-file-to-trips-by-date.md), [ADR-0029](0029-expense-reports.md), [ADR-0032](0032-features-switched-per-organization.md), [ADR-0035](0035-own-records-and-invite-links.md), [ADR-0036](0036-categories-and-types.md), [ADR-0043](0043-single-step-approval.md)
