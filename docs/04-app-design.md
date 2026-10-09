# App design

An inbox, not a form: design principles, information architecture, the four key screens, and the design system (blueprint §5).

Traditional expense tools are forms that people fill in. ExpenseWise fills in its own forms and shows people the few things it isn't sure about. The design follows from that.

## 5.1 Design principles

| ID | Principle | What it means |
| --- | --- | --- |
| DP1 | The system drafts; people confirm | Every expense starts as a draft the system has already filled in. We measure success in touches per expense, not in screens shipped. |
| DP2 | An inbox, not a form | Home is a short queue of the things that need you. Everything else is already done, and the page says so. |
| DP3 | Show the evidence | Each extracted field shows the receipt text it came from and how sure the system is. One tap corrects it, and the correction improves the next suggestion. |
| DP4 | Thumb-first | Primary actions sit in the bottom third of the screen, and capture is one tap from anywhere. Desktop adds density, such as tables and receipt-beside-fields, but keeps the same flows. |
| DP5 | Legible money | Figures use tabular numerals and always show the currency. Status is never carried by color alone. The target is WCAG 2.2 AA from the first screen. |
| DP6 | Predictable automation | Every automatic action says what it did and why, and can be undone until approval. People switch off surprises, so there shouldn't be any. |

## 5.2 Information architecture

| Group | Who sees it | Destinations |
| --- | --- | --- |
| Tab bar | Everyone. Five destinations, with capture in the middle. | **Home (inbox)**, Expenses, **Capture +**, Trips, Reports |
| Contextual | Shown where the work happens, not in the tab bar | Mileage (from Capture and Trips), Approvals (for approvers, badged), Insights, Settings and notifications |
| Admin | Role-gated: finance admins and owners only | Members and roles, Policies, Categories and GL codes, Mileage rates, Integrations, Audit log |

## 5.3 Key screens

The screens are low-fidelity and illustrative, with sample data. They show the Phase 2 experience; Phase 1 omits the parts marked P2 elsewhere in these docs. All four are phone layouts with the five-item tab bar (Home, Expenses, +, Trips, Reports) at the bottom.

### Home inbox

Home is an inbox: three items need Alex, and everything else is handled.

- **Header:** "Needs you", 3 items.
- **Card (warning): 2 receipts need a quick look.** Blue Bottle: date unreadable. Shell: totals don't add up. Action: "Review".
- **Card (warning): Parking receipt missing.** Houston · Acme onsite · Sep 25. Holds Friday's auto-submit. Action: "Snap it or add a note".
- **Card (info): Chicago client visit returned.** Jordan: "Add attendees for the Sep 18 dinner." Action: "Fix".
- **September so far:**

  | Figure | Value |
  | --- | --- |
  | Spent | $3,412.07 |
  | Expenses · trips | 21 · 2 |
  | Business miles | 184.6 mi |
  | Awaiting reimbursement | $862.40 |

- **Tab bar:** Home is selected.

### Receipt review

Evidence beside every field. The line behind the unsure field is highlighted on the receipt.

- **Header:** "Check 1 field", read in 4 s.
- **Receipt text,** with the TAX line highlighted:

  ```text
  HOTEL ZAZA HOUSTON
  ARR 09/22/26  DEP 09/25/26
  ROOM 3 NTS ........ 427.22
  TAX ................ 72.63
  TOTAL ............. 499.85
  VISA **** 4417
  ```

- **Extracted fields:**

  | Field | Value | Confidence |
  | --- | --- | --- |
  | Merchant | Hotel ZaZa Houston | sure |
  | Date | Sep 25, 2026 | sure |
  | Total | $499.85 USD | sure |
  | Tax | $72.63 | check |
  | Category | Lodging | suggested |
  | Trip | Houston · Acme onsite | by dates |

- **Actions:** "Looks right" (primary), "Edit a field" (secondary).

### Trip timeline

The trip is the report. Mileage is 38.4 mi at a sample org rate of $0.70/mi.

- **Header:** Houston · Acme onsite. Sep 22–25 · 4 days · client onsite.
- **Progress:** 7 of 8 ready · 1 missing receipt. Total $1,257.60.
- **Timeline:**

  | Day | Item | Amount | Flag |
  | --- | --- | --- | --- |
  | Mon 22 | United · IAH round trip | $412.20 | |
  | Mon 22 | Drive to airport · 38.4 mi | $26.88 | |
  | Tue 23 | Uber | $31.45 | |
  | Tue 23 | Local Foods · lunch | $18.92 | |
  | Wed 24 | Pappas Bros. · dinner (2) | $184.20 | Over $75 per person |
  | Thu 25 | Hotel ZaZa · 3 nights | $499.85 | |
  | Thu 25 | Uber | $36.10 | |
  | Thu 25 | Parking | $48.00 | Receipt missing |

- **Actions:** "Add parking receipt" (primary), "Submit with a note" (secondary).
- **Tab bar:** Trips is selected.

### Approvals

Jordan reviews one exception, not eight lines.

- **Header:** "Approvals", 2 waiting.
- **Report card:** Houston · Acme onsite. Alex Rivera · Sep 22–25 · 8 expenses. Total $1,257.60.
- **Exceptions (1):** Pappas Bros. · dinner, $184.20. 2 attendees · $92.10 each · limit $75. Note: "Client dinner with Acme CFO."
- **Checks:**

  | Check | Result |
  | --- | --- |
  | Receipts attached | 8 of 8 |
  | Duplicates | none |
  | Mileage vs route | matches |
  | Other 7 expenses | in policy |

- **Actions:** "Approve $1,257.60" (primary), "Return with comment" (secondary).
- **Footnote:** "In teams, your own reports route to your manager."

## 5.4 Design system and accessibility

- **One set of tokens.** Color, type, spacing and radius live in one package, exported to CSS for web and to Swift for iOS with Style Dictionary, so both apps share one brand.
- **One identity, Carbon.** The mark, the type, the colors, the icons and the voice are in the [brand guide](brand.md) ([ADR-0049](adr/0049-the-carbon-identity.md)).
- **Components we own.** Tailwind CSS with shadcn/ui on Radix primitives gives us accessible components as source code instead of a library we have to fight.
- **Every state designed.** Each screen has designed empty, loading, processing, offline and error states. "Processing" is a first-class state because extraction is asynchronous.
- **Accessible by default.** WCAG 2.2 AA, fully keyboard-operable on web, Dynamic Type on iOS, and automated axe checks in CI (gate G5; see [quality gates](06-delivery-lifecycle.md#73-quality-gates)).

## Related

- [Journeys and workflows](03-journeys-and-workflows.md): the golden path these screens serve.
- [Architecture](05-architecture.md#610-how-the-iphone-app-slots-in): how the iPhone app shares the API and tokens.
