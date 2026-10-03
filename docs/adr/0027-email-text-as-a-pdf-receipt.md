# ADR-0027: An emailed receipt's text becomes a PDF receipt

When an email arrives with nothing attached that can be a receipt, its text becomes the receipt: the HTML is turned into plain text with its tables kept in columns, laid out as a PDF and read like any upload. Readings also learn two things emailed receipts need: fees that are neither tax nor tip, and purchase summaries, which always wait for review.

- **Status:** Accepted (product owner asked for HTML email bodies to be read first, Oct 3; how, recommended, no objection)
- **Date:** 2026-10-03
- **Deciders:** Product owner (priority); Claude (principal architect), for the design
- **Decision register:** D-29. Builds on [ADR-0026](0026-email-in-through-a-bird-mailbox.md).

## Context

[ADR-0026](0026-email-in-through-a-bird-mailbox.md) filed only an email's attachments, and kept its text for later (#58). The first real test was a forwarded Uber receipt, and it showed the gap. Uber, Lyft, airlines, hotels and online shops send the receipt as the email itself, with no PDF attached. On Oct 3 the product owner asked for HTML email bodies to come first.

Three things were in the way:

- **The reading pipeline only reads files.** The models, the receipt page, storage and the checks all work on images and PDFs. A receipt is shown as its file, and the file is its proof.
- **Ride receipts never added up.** The sums check (FR-INT-04) added subtotal, tax and tip. An Uber receipt also charges a booking fee and an airport surcharge. Those are neither tax nor tip, so every ride failed the check and landed in Needs you.
- **Q10 had no mechanism.** The product owner's answer to Q10 is that a purchase summary, such as an order confirmation, always waits for review. Nothing in a reading said what a summary was.

## Decision

1. **The text becomes a PDF.** A proved email with nothing attached that can be a receipt is filed as one receipt: its text, laid out as a PDF.
   - **What goes in:**
     - The HTML part is preferred over the plain part, which is often only a link to the HTML.
     - The HTML is turned into text by html-to-text. Tables become columns, so each amount stays beside its label. Pictures, link targets, styles and scripts are left out.
     - Nothing is ever fetched from the internet, so a tracking pixel never tells the sender the email was opened.
   - **The PDF:**
     - pdf-lib lays the text out in Courier, monospaced, so columns of amounts stay lined up.
     - It is headed by "Received by email" and the subject.
     - It runs to at most five pages. Each page is read by both models at a cost to the organization's key, and no receipt needs more; a longer email is cut, with a note saying so.
     - The same text gives the same bytes every time. Retries store one file, and the same email forwarded twice is recognized as one receipt.
   - **After that,** the PDF is stored, filed and read by the models exactly like an upload. The receipt page shows it as the proof.
2. **Attachments win.** When something is attached that can be a receipt, the attachments are filed and the text isn't, so one purchase is never filed twice.
3. **Readings have fees** (`receipt-v2`).
   - Each fee or surcharge that is neither a tax nor a tip, such as a booking, service, delivery or airport fee, is read as a fee. Tax stays tax, as tax reporting needs.
   - The sums check adds subtotal, tax, fees and tip, and allows a minor unit of rounding per tax, fee or tip line. The receipt page shows the fees.
   - Readings stored before this have no fees. They are read back as having none, so they are judged as before.
4. **Purchase summaries are marked and never Ready on their own.**
   - A document that confirms an order without showing it was paid is read as a `purchase_summary`.
   - It fails a new check, `summary`, so it is never Ready on its own, whatever its confidence.
   - Needs you says "It's a purchase summary: check what was charged." Confirming it files it like any other reading.
5. **Every email leaves a trace.** The workflow logs one line per email: its Bird message id and what came of it. It contains no addresses or content.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Render the HTML in a headless browser to a PDF or image | Faithful to the layout, but it needs Chromium in a serverless function (heavy and slow). It would also fetch every remote image, tracking pixels included. |
| Send the text to the models as text, and store it as a text file | Touches the extractors, storage's allowed types, the receipt page and the evals. Each place that knows a receipt is a file would need a second kind of receipt. |
| Put fees in with taxes | The sums would add up, but tax would be wrong. A booking fee isn't tax, and tax figures feed tax reports. |
| Loosen the sums check for ride receipts | It hides real misreadings. The fees are printed, so reading them is the honest fix. |

## Consequences

### Positive

- **The common case works.** Ride, airline, hotel and order emails are filed as a receipt with no change to the reading pipeline. The proof is a clean, monospaced copy of what the email said.
- **Ride receipts can be Ready.** They can now be Ready on their own, and so can any receipt with service or delivery fees, whether emailed or photographed.
- **Q10 is enforced.** It is enforced by a check, which also says why on the receipt and in Needs you.

### Negative

- **The proof isn't a picture of the email.** Logos, colours and maps are gone, and layout tables become text. The amounts and their labels stay together, and that is what the proof is for.
- **Some characters are lost.** The PDF's standard font covers Latin script. Common currency signs outside it, such as ₹ and ₩, are written as their ISO codes. Other scripts, such as Japanese, become question marks. Receipts in those scripts need their attachment or a photo until a wider font is embedded.
- **Old readings can't be judged on fees.** Readings made before fees existed would still fail the sums check if they had fees. Reading such a receipt again fixes it.

## Exit path / reversibility

- **Rendering.** The PDF is made in one function, `emailAsPdf`. A browser-rendered version could replace it without touching anything downstream.
- **Fees and summaries.** These are part of the reading schema, versioned as `receipt-v2`. Undoing them means a `receipt-v3` without them; stored readings keep the version they were made with.

## Links

- [ADR-0026: Email-in through a Bird agent mailbox](0026-email-in-through-a-bird-mailbox.md), [ADR-0006: Receipt extraction](0006-receipt-extraction.md), [ADR-0022: Expense follows its receipt](0022-expense-follows-its-receipt.md)
- [html-to-text](https://github.com/html-to-text/node-html-to-text), [pdf-lib](https://pdf-lib.js.org/)
