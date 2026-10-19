# ADR-0052: Places are suggested as a stop is typed, and a place picked is measured from where it is

A drive's start, stops and end suggest places as they are typed. The person's saved places and the places their own drives went to come first, matched on the phone with nothing sent. Then come landmarks, businesses and addresses from OpenRouteService's Pelias autocomplete, asked in the request with the organization's own key. A place picked is pinned: the drive is measured from exactly where it is, and its address is never searched again. A stop typed without picking is searched as typed, as before.

- **Status:**
  - Suggestions for landmarks and destinations: accepted, the product owner's requirement of Oct 19 ("type in landmarks and destinations in the from and to fields and the app suggests and pulls the address").
  - A place picked measured from its exact point: accepted, decided by the product owner on Oct 19 (Q53). This revisits Q32 for picked places only.
  - Ranking near the drive's earlier stops and inside the organization's country, never the device's location: accepted, decided by the product owner on Oct 19 (Q54).
  - The provider, the lookup in the request, sealed picks, the limits and the flag: recommended by Claude, with no objection yet.
- **Date:** 2026-10-19
- **Deciders:** Product owner (Oct 19, Q53, Q54); Claude (principal architect), for the design
- **Decision register:** D-54
- **Amends:** [ADR-0039](0039-route-mileage-with-openrouteservice.md). Its point 8, each address sent as typed every time, now covers stops typed; a stop picked is measured from where it was picked. Its "choosing among several matches" leaves the out-of-scope list. Its one call to OpenRouteService made in a request, the key check, becomes two.

## Context

On Oct 19 the product owner asked that a person can type a landmark or destination in a drive's From and To and have the app suggest it and fill in its address. Until now a stop was an address typed in full, or a saved place's address copied in. The route-measuring workflow then searched each one and routed through the best match.

- **The best match could be the wrong place.** ADR-0039 named this among its consequences: "Starbucks" or "the airport" is routed to whichever match OpenRouteService ranks first. The page showed where each stop was found, but the person could only retype it.
- **Suggestions have to come while the person waits.** The outbox and workflows (AP3) suit work nobody watches. A suggestion that arrives after the person has typed the whole address is no use.
- **The key must stay on the server.** It is the organization's OpenRouteService key, stored sealed (Q31). The browser can't call OpenRouteService itself without it.
- **The free key has room.** Its Standard plan allows 1,000 autocomplete lookups a day and 100 a minute, apart from the 1,000 searches measuring uses (openrouteservice.org/plans, checked Oct 19).

The product owner answered two questions on Oct 19:

- **Q53.** A place picked from the suggestions is measured from its exact point (A), not searched again by its text (B, Q32 as it stood).
- **Q54.** Suggestions rank near the drive's earlier stops and inside the organization's country (A), not near the device's location, which would send where the person is to OpenRouteService (B).

## Decision

1. **The suggestions, in order:** the person's saved places, then places their own route drives went to, then OpenRouteService's.
   - Saved places and places driven to are matched in the browser, by name or address, with nothing sent.
   - Before anything is typed, the stop offers up to five of each.
   - Typed, it offers up to three of each that match, then OpenRouteService's places.
   - A place driven to that OpenRouteService also suggests shows once.
2. **OpenRouteService is asked in the request** (`POST /v1/mileage/place-suggestions`), the second of its calls made inline after the key check.
   - It is only a read, and nothing is stored.
   - It is asked once typing pauses for 300 ms (R-SUGGEST-WAIT), from three characters (R-SUGGEST-MIN), once for each text typed.
   - It waits three seconds at most (R-SUGGEST-TIMEOUT).
   - It shows five places at most (R-SUGGEST-SHOWN).
   - The organization's key is read on the server as the measuring workflow reads it. A member gets suggestions, never the key.
3. **What is sent (Q32, Q54):** the text typed, in the request's body so it reaches no URL or log line of ours, plus the organization's country and the place picked nearest the stop in the drive. Nothing else is sent: not a place's name, the purpose, a note, or the device's location. The form says so in one line.
4. **A place is read as a person reads it:** its name, then its street when OpenRouteService knows one and the name isn't already a street address, then its town and region. Picked, the stop's address is all of it in one line, such as "Eppley Airfield, 4501 Abbott Drive, Omaha, NE, USA".
5. **A place picked is pinned (Q53).**
   - The stop keeps OpenRouteService's name for it and its point, to six places, from the moment it is saved (`mileage_route_stops.pinned`, migration 0061).
   - The workflow routes from that point without searching it.
   - Typing over a picked stop makes it a stop typed again.
   - A place driven to before is pinned where it was found then.
   - A saved place still copies only its address, searched as typed, as Q32 decided for it.
6. **A pick can't be made up.**
   - Each place offered carries a pick: its name and point sealed with the app's SecretBox (ADR-0015), bound to the organization.
   - A stop is pinned only by a pick that opens. One made up, altered or from another organization is refused, naming the stop.
   - So a stop is only ever measured from a place the server suggested, found or kept. A person can't send an address with a point far from it to claim more miles.
   - The drive's own stops carry their picks, so changing a drive keeps them.
7. **No key, or no answer, is never an error.** Without a key, with a refused or used-up key, or with OpenRouteService unreachable, the stop says so in a line and is typed, as it always could be.
8. **The field is a combobox** (WAI-ARIA): the arrow keys move through the places, Enter picks one, Escape closes the list, and a status line tells a screen reader how many there are. The places carry OpenRouteService's attribution.
9. **It ships behind `expenses.place-suggestions`** (ADR-0032), which needs Route mileage. Off, the stop is typed and a saved place is chosen from its list, as before. A stop picked while it was on stays pinned.

Out of scope: dropping a point on a map; suggestions ranked by the device's location (Q54); a saved place pinned to a point.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Google Places Autocomplete | Better on small businesses and new addresses. But it brings a new vendor, key and bill, and its terms keep its places from being used with another provider's routes. With OpenRouteService, what is suggested is what is routed. |
| The browser asks OpenRouteService itself | It would need the organization's key in the browser. |
| Suggestions through the outbox | They would come after the person had typed the whole address. |
| Search the picked place's text again when measuring (Q53, B) | The top match for the text can be another place, the weakness this fixes, and it spends a search the pick already made. |
| Trust a point the browser sends | Anyone could send an address with a point far from it. Sealing the pick costs one small encryption. |
| Keep the suggestions in a table, the stop naming one | A table to clean up, for what a sealed pick carries itself. |
| Rank near the device's location (Q54, B) | It sends where the person is, a new kind of personal data, for a better first stop away from home. |

## Consequences

### Positive

- **A landmark or business is a stop in a few letters,** and the address is filled in, as asked.
- **What the person picked is what is measured.** "The airport" can no longer be routed to the wrong one.
- **Repeat places cost nothing:** saved places and places driven to are matched on the phone.
- **A picked stop spends no search when measured.**

### Negative

- **Another call made inline.** A slow OpenRouteService can't slow anything but the suggestions themselves, which give up after three seconds.
- **The allowance can run out:** 1,000 lookups a day is roughly 200 to 300 stops typed. The stop then says so and is typed.
- **What is typed goes to OpenRouteService as it is typed,** not only once saved. That is still only the stop's text, as Q32 allows. A home address typed in full is sent while it is typed.
- **OpenStreetMap is thinner than Google on small businesses and new buildings.** A stop then falls back to its typed address.
- **Tested against a fake, not the live service.** The request and answer follow the Pelias autocomplete reference: `text`, `boundary.country`, `focus.point.lon` and `focus.point.lat`, and an answer of GeoJSON features whose `properties` hold `name`, `housenumber`, `street` and `label`. The key goes in the Authorization header, as for search.

## Exit path / reversibility

- **The flag hides it,** and the form is as it was. A pinned stop measured again is measured from its point, as saved.
- **Another provider** is another `placeSuggester`. A pin is only a name and a point, whoever suggested it.
- **The column can go** once no drive still to be measured is pinned. A pinned stop then reads as found where it was picked.

## Links

- FR-CAP-14, FR-CAP-04, F-71, F-14, US-MILE-12, Q32, Q53, Q54, GAP-56, backlog #108
- [ADR-0039: Route mileage](0039-route-mileage-with-openrouteservice.md), [ADR-0015: AI provider keys in the app](0015-ai-provider-keys-in-app.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md)
- OpenRouteService: its plans (Standard: 1,000 autocomplete lookups a day, 100 a minute) and Pelias autocomplete
