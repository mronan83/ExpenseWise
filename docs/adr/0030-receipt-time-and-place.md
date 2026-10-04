# ADR-0030: A receipt's time and place are read with it, and the time zone is looked up offline

Each reading now captures the time of purchase and the merchant's address, both optional and each with its confidence. The expense carries them, and the person can edit them. The time zone is worked out from the city, region and country by a lookup bundled with the app, so no address leaves ExpenseWise.

- **Status:** Accepted (what is read decided by product owner, Oct 3, Q9; the offline lookup and the rules recommended, no objection)
- **Date:** 2026-10-04
- **Deciders:** Product owner (what a reading captures, and that the person can edit it); Claude (principal architect), for the design
- **Decision register:** D-32. Extends the reading schema of [ADR-0006](0006-receipt-extraction.md). Needed by duplicate matching on time and place (#61, [ADR-0028](0028-possible-duplicates.md)).

## Context

FR-INT-17 asks for the time of purchase and the merchant's address, each with its confidence. The expense carries them too, editable. The address is kept as printed, with its city and country picked out. The time is kept as printed, with its time zone worked out from the address where it can be, and set by the person where it can't. Either may be blank, and a blank one never makes a receipt need a look.

The product owner's amendment of Oct 4 (GAP-23) matches duplicates on vendor, date, time and place, not on total. That needs both read from every receipt.

A local time means little without its zone: 18:42 in Omaha and 18:42 in Denver are an hour apart. Most receipts print a city and region but no zone.

## Decision

1. **The reading schema is `receipt-v3`, the prompt `extract-v3`.**
   - `time` is HH:MM on a 24-hour clock, with its confidence, or null.
   - `address` is the printed text, with city, region and an ISO 3166-1 alpha-2 country picked out, and its confidence, or null.
   - Readings stored before v3 read back with both null.
2. **Neither ever makes a receipt need a look.** A time that isn't a time of day, or a country that isn't two letters, is dropped to null when normalized. It is never raised as a problem. The tier decision and the checks of FR-INT-04 are unchanged.
3. **The time zone comes from an offline lookup.** `timeZoneFor()` in `@expensewise/extraction/place` tries, in order:
   - the city's zone;
   - the zone of the region's most populous city;
   - the country's zone, if the country has only one.

   Otherwise the zone is null. The data is the `city-timezones` package (MIT), about 7,300 world cities in simplemaps' basic world-cities list, matched without case, accents or punctuation. It runs on the server; nothing is sent anywhere.
4. **The expense carries six columns:** `transaction_time`, `time_zone`, `merchant_address`, `merchant_city`, `merchant_region` and `merchant_country`.
   - Checks keep the time HH:MM and the country two capital letters.
   - A reading fills them when the expense is filed or read again, as it does the other fields.
   - Once the person edits the expense, later readings leave all of them alone.
   - A reading that offers no time or place leaves them as they are.
5. **The person edits them on the expense.**
   - Changing the city, region or country works the zone out again, unless the same edit sets a zone.
   - A blank zone asks for it to be worked out from the place.
   - The person can pick any zone the browser knows.
   - Each change is in the audit event, as other edits are.
6. **A difference from the receipt is shown, never a reason to reject.** The expense page shows a time or place that differs from its receipt, but review (FR-GOV-10) judges what is claimed: merchant, date, currency and amount.
7. **The eval set scores them.** `time`, `city` and `country` are scored where the truth has them. The synthetic restaurant slips print a time and the folios a city. They are drawn in the same order as before, so each seed makes the same document.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A geocoding API (Google, Mapbox) | Every address would leave ExpenseWise, at a cost per receipt, and a request would wait on it. The city is enough to find a zone. |
| Ask the model for the time zone | It would guess with confidence, and differently from run to run. A lookup gives the same answer every time and can be fixed in one place. |
| The device's time zone at capture | A receipt is often captured days later, at home. It says where the phone is, not where the purchase was. |
| Store a UTC instant instead of a local time | The receipt prints a local time. Without a zone the instant is unknown, and a wrong zone would corrupt it silently. Local time plus zone keeps what was printed. |
| A full IANA boundary lookup by coordinates | It needs coordinates, so a geocoder first, and its data is tens of megabytes. City, region and country answer almost every receipt. |

## Consequences

### Positive

- **Duplicates can be matched on when and where (#61).** Two receipts of the same purchase share a time and a place even when a tip changes the total.
- **No address leaves ExpenseWise.** The lookup is code and data in the app.
- **A blank never costs the person anything.** Time and place are extra; a receipt without them is Ready as before.

### Negative

- **A small town may not be in the list.** It then falls back to its region's largest city, which is wrong for a region split by a zone line, such as western Nebraska. The person can set the zone.
- **The lookup adds about 2 MB to the server bundle.** It is loaded once per server instance, not in the browser.
- **The data is a snapshot.** Zones rarely change; when they do, a newer package or a hand-kept override fixes it in one function.

## Exit path / reversibility

- **The lookup.** It is one function behind one import. A geocoder or another dataset can replace it without changing callers.
- **The columns.** They are nullable and nothing depends on them yet except #61, so they can be dropped with one migration.

## Links

- [ADR-0006: Receipt extraction](0006-receipt-extraction.md), [ADR-0022: An expense follows its receipt](0022-expense-follows-its-receipt.md), [ADR-0028: Possible duplicates](0028-possible-duplicates.md)
- FR-INT-17, FR-INT-01, F-46, backlog #53, #61, GAP-23
