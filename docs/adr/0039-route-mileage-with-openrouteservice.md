# ADR-0039: Route drives are measured by OpenRouteService, with each organization's own key, after the request

A drive given as its start, stops and end is saved at once and measured afterwards by a workflow, which finds each stop and routes by car through them with OpenRouteService on the organization's own key; the claim keeps the distance in metres, its source and when, pays its miles at the rate on the drive's date, and is never measured again unless the person changes its stops before it is submitted.

- **Status:** Accepted (OpenRouteService, researched at the product owner's request, and the go-ahead decided by product owner, Oct 4, #20; the key in Settings, checked on save and stored encrypted, decided by product owner, Q31; each address sent as typed, never a name, note or purpose, decided by product owner, Q32; miles changed only with a reason, the claim and its export showing both, decided by product owner, Q33; the workflow, the stored shape, the arithmetic and the limits recommended by Claude, no objection yet)
- **Date:** 2026-10-04
- **Deciders:** Product owner (#20, Q31 to Q33); Claude (principal architect), for the design
- **Decision register:** D-41. Builds on [ADR-0038](0038-manual-mileage.md), whose drive it extends, and [ADR-0015](0015-ai-provider-keys-in-app.md), whose key handling it follows.

## Context

FR-CAP-04 asks for mileage by route: a start, stops and an end, a round trip and saved places, with the distance from a routing service and its source recorded. NFR-DAT-04 asks that what a claim is priced on is copied onto it. ADR-0038 made a drive an expense with a mileage log, paid at the IRS business rate on its date, and left method `route` for this.

Researched on Oct 4 at the product owner's request: OpenRouteService (HeiGIT, on OpenStreetMap data) has a free Standard key, with no card, for about 1,000 address searches and 2,000 routes a day, through up to 50 points in one route, with commercial use allowed and attribution required. Google's Routes API needs billing enabled; GraphHopper's free plan allows 5 points and no commercial use; Mapbox doesn't let free lookups be stored; hosting a US map ourselves needs far more memory than a free host has. The product owner made an OpenRouteService account and answered:

- **Q31.** The key lives in the app, in Settings, checked when saved and stored encrypted, like the AI keys.
- **Q32.** Each address is sent as typed, every time a drive is measured; never a name, note or purpose.
- **Q33.** The measured miles may be changed with a reason; the claim and its export show the miles measured and the person's.

Measuring calls another service, which AP3 and the outbox rule keep out of a request.

## Decision

1. **Saving a drive asks for it to be measured; a workflow measures it.** `POST /v1/mileage/routes` writes the expense (source `mileage`, processing, no amount), its mileage log (method `route`, the rate on its date copied on, no miles yet), its route and its stops as typed, an outbox event and the audit event, in one transaction, and hands the event to the runner after the commit. Until it is measured the drive shows Measuring…, and its report can't close, as for a receipt being read.
2. **The workflow `route-measuring`** loads the stops for the request it was given (the outbox event's id, kept on the route; a later change of stops makes an earlier request stale, so its answer is never recorded), finds each stop with Pelias search on api.openrouteservice.org (the best match, narrowed to the organization's country when it keeps one), then asks for the `driving-car` route through the points in order, with the start appended on a round trip. One organization's drives are measured one at a time.
3. **What is recorded:** each stop as typed, the place it was found at (label) and its coordinates to six places; each leg in whole metres, rounded half up from OpenRouteService's figure through its decimal digits, and the total as the sum of the legs, so the legs always add up to it; the provider, the profile and when. Miles are hundredths of a mile from the metres, `metres × 100,000 ÷ 1,609,344` rounded half up in integer arithmetic (a mile is 1,609.344 m exactly). The drive then claims those miles at the rate in force on its date, through the same domain rules as a drive logged by hand (`quoteMileage`, `rateOn`), and is Ready.
4. **A drive that can't be measured needs a look, with the reason in plain words:** a stop OpenRouteService can't find (named, with its address) or with no road near it; no key, a key that can no longer be decrypted, or one OpenRouteService refuses (401, 403, not tried again); a route longer than one entry claims (1,000 miles) or of no distance. A busy or used-up service (429, 5xx, no answer) is asked again by the workflow, three more times, then the drive needs a look saying so. The person fixes a stop and measures it again, asks to measure it again unchanged (after adding a key, say), or enters the miles by hand with a reason.
5. **The miles claimed can differ from those measured, with a reason (Q33).** `PUT /v1/mileage/{id}/route/miles` claims other miles, priced again at the rate on the drive's date; the measured miles, metres, source and time stay beside them, and the audit trail records the miles before and after, the reason and the miles measured. Claiming the measured miles again drops the reason. The drive's page and the report's CSV and PDF show the miles measured, the miles claimed and the reason.
6. **A claim is never measured again on its own.** Only new stops or a round trip switched, by its person, before it is submitted, measure it again; a new date prices the miles claimed again at that day's rate, and a new purpose changes nothing else. Submitted or approved, it is locked like any expense; editing it as a drive logged by hand is refused with 409 `route`.
7. **The key (Q31)** is the organization's, in Settings › Mileage, managed by owners and finance admins as AI keys are (ADR-0015). It is checked in the request when saved, with one short route of about a kilometre, the cheapest call that proves the key routes; this is the one call to OpenRouteService made inline, as ADR-0015 checks AI keys inline, because the person is waiting to know whether the key works and nothing is stored if it doesn't. It is stored in a table of its own, `route_service_keys`, sealed with the same SecretBox as the AI keys and bound to the organization and provider (`<org>:route:openrouteservice`), shown only by its last four characters, removable, audited, and never logged or returned. A sibling table rather than a third provider in `ai_provider_keys`: that table's provider type, its listing and its auth-scheme column are the AI keys' own, so OpenRouteService there would show in Settings › AI providers and widen every AI provider type; the protections are the same.
8. **What is sent (Q32):** each address as typed, every time the drive is measured, in the search's text, with the key in the Authorization header, never in a URL; then the found coordinates for the route. Never a place's name, a purpose or a note. The form says so in one line.
9. **Saved places** are each member's own (`saved_places`, under the own-records rules of ADR-0035): a name, once per person, and an address. Picking one copies its address onto a stop; its name is never sent. The audit trail records a place's name, and that its address changed, not the address.
10. **Attribution** shows wherever a measured route does: the drive's page, Settings › Mileage and the report's export: "Route © openrouteservice.org by HeiGIT · Map data © OpenStreetMap contributors".
11. **It ships behind `expenses.route-mileage`** (ADR-0032): off, its operations answer 404 `feature_off`, By route, the drive's route and Settings › Mileage's sections are hidden, and the export is as it was. A route drive made while it was on stays an expense.
12. **Limits, in the register:** at most 25 places a drive, its start and end included, within OpenRouteService's 50 points even as a round trip and keeping a drive's lookups well inside 1,000 a day (R-ROUTE-STOPS); three more tries for a busy service (R-ROUTE-RETRIES); a reason of up to 500 characters (R-MILES-REASON-MAX).

Out of scope: a map, kilometres, dropping a point on a map instead of an address (Q32's option C), choosing among several matches for an address, and routes by bicycle or on foot.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Measure in the request, as the person saves | A call to another service inside a request, against AP3 and the outbox rule; a slow or used-up OpenRouteService would fail the save. |
| The key as a Vercel environment variable | Q31: B. It needs a redeploy, shows no check, and lends one person's free key to every organization. |
| Look a saved place up once and send only its point afterwards | Q32: A, recommended, not chosen. The owner chose each address as typed, every time. |
| Store the route in `mileage_logs` (its unused `waypoints` column) | The measurement's rules (whole when measured, a reason when failed, a place found whole, one stop per position) would be checks on a JSON value; separate tables keep them as constraints. |
| The key as a third provider in `ai_provider_keys` | It would show among the AI keys and widen the AI provider type and its auth-scheme column; a sibling table keeps the same protections without either. |
| Re-measure a claim when OpenRouteService's map changes | Q33's reasoning: a claim keeps the distance it was measured at, and is never measured again on its own. |

## Consequences

### Positive

- **A drive is saved in a moment, measured seconds later,** and claimed, filed and reported exactly as a drive logged by hand, at the same rate.
- **Every claim says where its distance came from:** metres per leg and in total, the provider, the profile and when, and the reason when the miles claimed differ.
- **Each organization uses its own free key,** checked on screen as it is saved.

### Negative

- **Home addresses go to OpenRouteService on every drive from home** (Q32's choice). Its terms ask that no personal data is sent; names, notes and purposes never are.
- **A free key's allowance can run out.** A drive then needs a look saying so, and can be measured again later or entered by hand.
- **The best match can be the wrong place.** The page shows the place each stop was found at, so a person sees it and fixes the stop; there is no choosing among matches yet.
- **One more secret is stored,** under the same box, roles, audit and tests as the AI keys; rotating the box's source secret makes it unreadable too, and a drive then needs a look asking for it to be saved again.

## Exit path / reversibility

- **The routing service sits behind one small interface** (`RoutingClient`: find an address, route through points) and one key check. Another provider, such as a self-hosted OpenRouteService or GraphHopper, is another implementation and another value of `route_provider`; drives already measured keep the provider they were measured by.
- **Switching the flag off** hides the feature and keeps every drive; removing it later drops the tables and the workflow after its drives are settled.

## Links

- FR-CAP-04, NFR-DAT-04, NFR-SEC-04, F-14, Q31, Q32, Q33, backlog #20
- [ADR-0038: Manual mileage](0038-manual-mileage.md), [ADR-0015: AI provider keys in the app](0015-ai-provider-keys-in-app.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md), [ADR-0035: Own records](0035-own-records-and-invite-links.md)
- OpenRouteService: its API (Pelias geocoding, directions v2), its Standard plan's limits and its terms
