# ADR-0049: The brand is Carbon: the paperwork, settled

ExpenseWise has one identity, Carbon. Its mark is a receipt whose torn edge is a W, on carbon-copy blue. It is set in IBM Plex, served with the app. Its colors are paper, ink and carbon, each text color at AA or better in light and dark. Its tab bar has icons drawn on the mark's grid, and it has app icons for every platform. The name stays.

- **Status:** Accepted (decided by product owner, Oct 9: direction A, keep the name, not to be sold)
- **Date:** 2026-10-09
- **Deciders:** Product owner; Claude (principal architect), for the design
- **Decision register:** D-51
- **Amends:** [docs/04-app-design.md](../04-app-design.md) §5.4, which named one set of tokens but no brand

## Context

The product owner asked for a full brand: logo, icons, colors, type. Four things came first.

- **The brand font never loaded.** The styles named IBM Plex Sans but nothing shipped it, so each device showed its own system font.
- **There was no home-screen icon.** Only an SVG icon existed. iOS needs a 180-pixel PNG for Add to Home Screen, and Android needs 192 and 512 to install.
- **The name is shared.** Two App Store apps use it, an Android app does corporate claims under a near-identical name, and a trademark for EXPENSEWISE was filed by another company.
- **The product already had a visual language.** Its tokens were named paper, sheet, ink, rule and carbon, and its copy was plain and exact.

Three directions were proposed, each checked against WCAG 2.2 AA before anything was built:

- **A, Carbon:** the receipt and carbon blue.
- **B, Ledger:** a ruled page and ledger green.
- **C, Departure:** a boarding pass and signal orange.

## Decision

1. **The mark is a receipt whose torn edge is a W, on a carbon tile.**
   - It is drawn from one geometry in `apps/web/scripts/brand-assets.mjs`. Its output is committed: SVGs in `public/brand`, the favicon, iOS, Android and maskable icons, and a share image.
   - In the app, `Wordmark` draws it in the theme's own colors at the top of every screen.
2. **IBM Plex Sans and Plex Mono, served with the app** from `@fontsource`. The build never fetches a font, and no visitor's browser asks a font host. Figures are tabular everywhere.
3. **The colors keep their names and roles.** The neutrals lean to the carbon blue. Carbon and the status colors are unchanged, so no status means something new. Every text color is at least 4.5 : 1 on paper, sheet and carbon-wash in both themes, checked by `e2e/shell` from the live tokens.
4. **The tab bar shows an icon above each label.** The icons are drawn on a 24-point grid with the mark's stroke and joins.
5. **The name stays ExpenseWise.** The app is for the owner and their team and won't be sold. If that changes, a name is cleared before launch, and the mark stays.
6. **The guide is [`docs/brand.md`](../brand.md):** strategy, voice, logo use, tokens, type and icons.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| B, Ledger | Green is the category's default, and the brand green would collide with “ready” green, which would have to change meaning. |
| C, Departure | Narrows the brand to travel while mileage and local spend matter too; orange crowds the amber of “needs a look”. |
| Rename now | Nothing is being sold; a name matters for a launch, not for a tool its owner uses. |
| Load the fonts from Google Fonts (`next/font/google`) | Every build would depend on a font host answering; self-hosting from npm keeps builds offline and visitors' browsers off third parties. |
| Leave the system font | Tabular figures then depend on each device's font; the brand would look different on every phone. |

## Consequences

### Positive

- One recognizable mark, on the home screen, the tab, a shared link and every screen.
- The figures line up the same on every device.
- The contrast promise is a test, not a claim.

### Negative

- **About 100 KB of fonts on a first visit,** cached after. Only the Latin subsets a page uses are fetched.
- **The brand files are generated.** Editing an SVG by hand is undone by the next run of the script, so changes go through it.

## Exit path / reversibility

- **Colors** are tokens in one file.
- **Type** is one theme variable and six imports.
- **The mark** is one geometry, and the script redraws every file.
- **A rename** changes the wordmark's text in the script and the components, and the mark stays.

## Links

- [docs/brand.md](../brand.md), [docs/04-app-design.md](../04-app-design.md)
- NFR-UX-07, F-68, US-UX-06, GAP-47, backlog #101
