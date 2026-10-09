# Brand: Carbon

How ExpenseWise looks and sounds, and why. Decided by the product owner on Oct 9, 2026 ([ADR-0049](adr/0049-the-carbon-identity.md)). The tokens live in [`apps/web/app/globals.css`](../apps/web/app/globals.css); the logo and icon files in [`apps/web/public/brand`](../apps/web/public/brand).

## Strategy

| | |
| --- | --- |
| **Purpose** | Give people back the hour that expense reports take, without asking them to trust a black box. |
| **Positioning** | For people who travel and spend for work, ExpenseWise is the expense app that files receipts, trips and miles itself and shows the evidence for every figure. Form-first tools make you type and hope; ExpenseWise drafts, shows its working, and asks only about what it isn't sure of. |
| **Audience** | First, the person on the road, on an iPhone, who wants receipts gone from their pocket and their head. Next, the approver and finance admin who must trust each claim without checking it again. |
| **Brand idea** | *Settled.* Every receipt filed, every charge documented, every number traceable. |

### Personality

| Is | Isn't |
| --- | --- |
| **Exact**: figures to the cent, with their currency | fussy or pedantic |
| **Calm**: quiet screens; only what needs you asks for attention | dull |
| **Candid**: says what it did, why, and when it isn't sure | spin |
| **Capable**: does the work and stays out of the way | cute or chatty |

### Voice

| Principle | Write | Not |
| --- | --- | --- |
| Say what happened | Filed to Q4 Architect Meeting. | Success! Your receipt has been processed. |
| Name the uncertainty | The models disagree on the total. Which is right? | Oops, something went wrong. |
| Plain words, real units | $487.13 · paid by the company | Corporate liability flag set |
| One action, one verb | Delete it · Keep it | OK · Cancel |

No exclamation marks, no apologies, no jargon a traveler wouldn't use. Dates read *Sep 30, 2026*; amounts always carry their currency.

### The name

ExpenseWise stays the name: the app is for the owner and their team and won't be sold (owner, Oct 9). Other apps share the name, so before any public launch the name would need clearing first. The mark carries the brand without it.

## Logo

**The mark** is a receipt whose torn edge is a W. The receipt is the job; the clean tear is *settled*. It sits on a carbon tile, the blue of carbon-copy paper.

| File | Use |
| --- | --- |
| `public/brand/mark.svg` | The tile, on light grounds; the favicon (`app/icon.svg`) |
| `public/brand/mark-dark.svg` | The tile on dark grounds |
| `public/brand/mark-full-bleed.svg` | Filling its square, for platforms that round or mask icons |
| `public/brand/lockup.svg`, `lockup-dark.svg` | Mark and name together |
| `public/brand/wordmark.svg`, `wordmark-dark.svg` | The name alone |

- **The wordmark** is *Expense* in IBM Plex Sans SemiBold and *Wise* in Regular, the letters drawn as outlines in the files so no font is needed.
- **Clear space** around the mark is a quarter of its width.
- **Smallest sizes:** the mark down to 16 px; the lockup down to a 20 px mark.
- **In the app**, the `Wordmark` component draws the mark in the theme's own colors at the top of each screen ([`app/brand.tsx`](../apps/web/app/brand.tsx)).
- **Don't:**
  - recolor the mark outside the palette;
  - outline it, stretch it, or add shadows or gradients;
  - turn the tear to face anywhere but down;
  - set the name in another typeface.

### App icons

| File | Size | Why |
| --- | --- | --- |
| `app/apple-icon.png` | 180 × 180 | iOS Add to Home Screen; full-bleed, iOS rounds it |
| `public/icon-192.png`, `icon-512.png` | 192, 512 | Android and desktop installs |
| `public/icon-maskable-512.png` | 512 | Android adaptive icons; the receipt sits inside the safe circle |
| `app/opengraph-image.png` | 1200 × 630 | A link shared in a message or a post |

Every file is drawn from one geometry by `pnpm --filter @expensewise/web brand:assets` ([`scripts/brand-assets.mjs`](../apps/web/scripts/brand-assets.mjs)). Change the script, run it, and commit what it writes.

## Color

Paper, ink and carbon: the paperwork the app replaces. Neutrals lean to the carbon blue so the page reads as one material.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `paper` | `#f4f5f8` | `#0e1018` | The page |
| `sheet` | `#ffffff` | `#161927` | A card or field on the page |
| `ink` | `#141729` | `#e6e8f0` | Text |
| `ink-2` | `#4a4f66` | `#a9aec2` | Secondary text, labels |
| `ink-3` | `#5d6279` | `#8e93a9` | Tertiary text |
| `rule` | `#dcdee7` | `#272b3c` | Borders and dividers |
| `carbon` | `#2d43c2` | `#9aa7ff` | The brand; links, the current tab, primary actions |
| `carbon-ink` | `#ffffff` | `#0e1018` | Text on carbon |
| `carbon-wash` | `#e8ebfb` | `#1d2245` | A highlighted row or panel |
| `ok` | `#1d7849` | `#4fc48c` | Ready, done |
| `warn` | `#965700` | `#e6a640` | Needs a look |
| `bad` | `#b42318` | `#f2786d` | Refused, missing, failed |

**Contrast is guaranteed.** Every text color is at least 4.5 : 1 on paper, sheet and carbon-wash in both themes, and carbon-ink on carbon too. The lowest pairing is 4.62 : 1 in light, `ok` on carbon-wash, and 5.05 : 1 in dark. `e2e/shell` reads the live tokens and fails if any pairing drops below; axe checks every screen as well. Status is never carried by color alone (DP5).

## Type

- **IBM Plex Sans** for everything people read, in Regular 400, Medium 500, SemiBold 600 and Bold 700. It is served with the app (`@fontsource`), never from a font host.
- **IBM Plex Mono** for what is printed rather than written: lines read off a receipt, codes and build numbers.
- **Tabular numerals everywhere**, so every column of money lines up to the cent.

| Use | Size | Weight |
| --- | --- | --- |
| Screen title | 24 px | Bold |
| Section heading | 18 px | SemiBold |
| Body | 16 px | Regular |
| Secondary and labels | 14 px | Regular or Medium |
| Small print, tab labels | 12 px | Medium, SemiBold when current |

## Icons

The tab bar's icons are drawn for the app ([`app/icons.tsx`](../apps/web/app/icons.tsx)):

- 24-point grid, 1.75 stroke, round caps and joins, in the current text color.
- Always beside their label, so screen readers skip them.
- Expenses is the mark's receipt with its torn edge.
- Capture is a heavier plus on the carbon button.

New icons follow the same grid and stroke.
