# ADR-0040: A reading's request is composed from additions, and journeys and stays are the second

An organization's reading asks the models for what it has switched on, and nothing more. Each feature that asks for more adds its own instructions, its own structure and its own version, independently of the others. Journeys and stays (`receipts.journeys`) is the second addition, after the line each field was read from (GAP-14). It reads where a ride, flight or train went, and a hotel folio's check-in and check-out. These follow the receipt onto the expense until a person edits them. The nights are worked out from the two dates and never kept.

- **Status:** Accepted (what is read decided by product owner, Oct 4: a ride's pickup and drop-off, a folio's dates and nights, and flights and rail too, Q39; asking only where the feature is on, as Q5 ships every feature; the composition, the versions, the 31 nights and what a doubtful stay does recommended by Claude, no objection yet); points 3 and 6 amended on Oct 6: a journey also reads the day it departs (`journeys-v2`), from the product owner's goal of each trip's full picture (FR-EXP-19, #94)
- **Date:** 2026-10-04
- **Deciders:** Product owner (FR-INT-20, FR-INT-21, Q39, Q5); Claude (principal architect), for the design
- **Decision register:** D-42. Extends the reading schema of [ADR-0006](0006-receipt-extraction.md) and follows [ADR-0030](0030-receipt-time-and-place.md) for fields that follow the receipt onto the expense ([ADR-0022](0022-expense-follows-its-receipt.md)).

## Context

FR-INT-20 asks a transportation receipt for where the journey went from and to. FR-INT-21 asks a hotel folio for its check-in and check-out, and the nights between them. Q39 extended the first from rides to flights and rail.

PR #58 made a second request for organizations with Where each field was read switched on (`extract-v4`, `receipt-v4`), and left every other organization's request byte for byte as it was. That was one switch and two requests. A second switch that adds to the request makes four. A third would make eight. Naming each by hand doesn't scale, and a stored reading must still say exactly what it was asked.

The document types had no rail ticket. Adding it to every request would change the request of every organization, the feature's or not.

## Decision

1. **A request is a base with additions.** An addition brings instructions, appended after the base's, and structure, added to the base's. A field it redefines keeps its place. Additions are independent: each organization gets the additions its switches turn on, in a fixed order.
2. **The version names what was asked.** It is the base's version, with each addition's joined on with `+`: `receipt-v3+journeys-v1`, or `receipt-v4+journeys-v1` with source lines too. Source lines keep the name `receipt-v4` (`extract-v4`) they had from when they were the only variant, so the readings made since keep theirs. With no addition on, the request is unchanged. A test holds both providers' requests to a hash of what they sent before.
3. **Journeys and stays add three things.** Each is offered only where they are asked for.
   - `rail_ticket` among the kinds of document.
   - `journey`: its `from` and `to`, each as printed with its confidence, or null.
   - *Amended Oct 6 (#94):* `journey` also has `departs`, the YYYY-MM-DD date its first leg departs, a return ticket's outbound one, never the day it was bought, with its confidence, or null. The addition's version is `journeys-v2`. A reading made with `journeys-v1` has no `departs` and still reads; a date that isn't one is blank, and a journey with only a departure is kept.
   - `stay`: its `checkIn` and `checkOut`, each a YYYY-MM-DD date with its confidence, or null.
4. **Only the right documents keep them.**
   - A journey is kept from a ride receipt, an airline ticket or a rail ticket.
   - A stay is kept from a hotel folio.
   - An end that doesn't read, or a date that isn't one, is blank.
   - Like time and place, a journey never decides Ready.
5. **The nights are worked out, never kept.** They are the days from check-in to check-out (`nightsOf` in the domain), so Sep 29 to Oct 1 is 2. A check-out before its check-in, or a stay longer than 31 nights (R-STAY-NIGHTS), is not sure. Its reading fails the `stay` check, so the receipt needs a look. The page says why rather than showing a wrong number, and the dates still file as read for the person to correct.
6. **The expense carries four columns:** `journey_from`, `journey_to`, `check_in` and `check_out`, all nullable.
   - *Amended Oct 6 (#94):* and a fifth, `departs_on`, which follows the receipt and is corrected the same way. The expense files to its trip by it (ADR-0023). The expense page, and the report's From and to column, read "SFO → ORD, departs Oct 20, 2026".
   - They follow ADR-0022: a reading asked for them fills them, and once a person edits the expense, later readings leave them alone.
   - A reading not asked for them (made before the switch, or with it off) leaves them as they are. A receipt read before gains them when it is read again.
   - The person corrects them on the expense page. An edit that leaves a check-out before its check-in, or more than 31 nights, is refused. Each change is in the audit event.
7. **A feature that is off looks absent** (ADR-0032).
   - The request asks for nothing of it.
   - The expense and receipt pages show nothing of it.
   - A correction sent anyway answers 404 `feature_off`.
   - Data kept while it was on stays.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A named version per combination (`receipt-v5`, `receipt-v6`, …) | Each new switch doubles the names, and the name no longer says what was asked. |
| Ask every organization for journeys and stays | Changes every organization's request for a feature most haven't switched on, against Q5. |
| Store the nights | They would be a second copy of the dates that could disagree with them. Worked out, they always match. |
| A stay that can't be right shows its number anyway | A negative or 400-night stay is a misread year or month, and a reviewer would trust it. |
| Keep a journey from any document | A restaurant's "from the kitchen" or a delivery address would read as a journey. |

## Consequences

### Positive

- **The next addition costs one entry.** Its instructions, its structure and its version.
- **Every stored reading says what it was asked,** including which additions it had.
- **No organization's request changes until its owner switches a feature on.**

### Negative

- **The four requests and their structures are made once per server** and kept for its life: a few kilobytes each.
- **A stay longer than 31 nights can't be entered.** A month-long stay is entered as two stays, or with its dates left blank.
- **The report export doesn't carry journeys or stays yet.**

## Exit path / reversibility

- **The composition.** It is one function (`variantOf`). Removing an addition removes its entry; stored readings keep their versions.
- **The columns.** They are nullable and read by nothing else, so one migration drops them.

## Links

- [ADR-0006: Receipt extraction](0006-receipt-extraction.md), [ADR-0022: An expense follows its receipt](0022-expense-follows-its-receipt.md), [ADR-0030: Time and place](0030-receipt-time-and-place.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md)
- FR-INT-20, FR-INT-21, Q39, F-54, US-READ-23, US-READ-24, backlog #79, GAP-14
