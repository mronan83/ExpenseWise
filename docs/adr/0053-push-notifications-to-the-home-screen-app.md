# ADR-0053: Push notifications to the app on the Home Screen, made by a sweep of the audit trail

A person allows notifications on their iPhone, in ExpenseWise added to the Home Screen, and switches each kind on or off. Every five minutes a sweep reads each organization's audit trail for changes that tell someone something, makes one notification for each person a change tells, and sends what each person has waiting as one push through Apple's push service. A notification says what and where, never an amount, and opens what it is about.

- **Status:**
  - Notifications for receipts emailed in, expenses needing review, trips and reports closed on their own, reports to approve and to submit: accepted, the product owner's requirement of Oct 19.
  - Web push to the Home Screen app now, ahead of the native app: accepted, decided by the product owner on Oct 19 (Q57).
  - What and where on the lock screen, never an amount: accepted, decided by the product owner on Oct 19 (Q58).
  - The other kinds (a possible duplicate, an email that filed nothing, a report approved or come back, a statement needing a look, a drive not measured), the sweep, batching, the morning reminder, the keys and the limits: recommended by Claude, with no objection yet.
- **Date:** 2026-10-19
- **Deciders:** Product owner (Oct 19, Q57, Q58); Claude (principal architect), for the design
- **Decision register:** D-55

## Context

On Oct 19 the product owner asked for notifications on their phone: receipts received by email, expenses needing review, trips and reports closed automatically, reports needing approval and reports needing submission, and anything else needed. The app is a web app added to the iPhone's Home Screen. Since iOS 16.4, Safari lets such an app receive Web Push, through Apple's push service, once the person allows it from a tap in the app.

- **The changes already have a record.** Every state change appends an audit event in its transaction, each with a sequence number per organization. A receipt read, a report closed by the schedule, one submitted: each is an event.
- **Slow or external work goes through the outbox and workflows, never a request** (AP3). Sending a push is a call to Apple.
- **Ten receipts emailed at once** should not buzz the phone ten times.
- **The server sends to an address the browser gives it.** Taken on trust, that would let anyone signed in make the server call any address.

## Decision

1. **A sweep reads the audit trail, rather than each change sending its own.** Every five minutes (R-PUSH-EVERY), and at once when a test is asked for (`notifications.push_requested`), the `push-sweep` workflow:
   - asks `push_work_due()` which organizations have a device allowed and either a notable change past their cursor or a notification still to send, ids only, as `report_work_due()` does;
   - in each, as the system and in one transaction, reads the trail past the cursor (`push_cursors`), up to 200 changes, and moves the cursor on;
   - makes, through the domain's `notificationsFor()`, a notification for each person each change tells, once (`notifications`, unique by person and key);
   - then sends each person's waiting notifications as one push to each of their devices, and records how it went.
   - No change to a producer was needed, a change missed by an event is never lost, and a notification is made at most once whatever retries.
2. **What each change tells** (the domain's `notificationsFor`):
   - A receipt emailed in and read: "Receipt from Delta filed". Only its first reading; one read again on request is not notified.
   - A receipt needing a look or not read, however it came in; one that may be a duplicate; an email that filed nothing.
   - A trip the report schedule put on a report, and a report the schedule closed, saying to submit it while approval is on. What the person did themselves is not notified.
   - A report submitted, to its approver, unless it self-attests.
   - A report approved or returned, to its owner, unless they decided it themselves.
   - A drive that couldn't be measured; a card statement needing a look.
   - Each only while the thing still waits as the change left it, so nobody is told of what they already did.
3. **A report still to submit is reminded of once a day** (R-PUSH-REMINDER), from 9:00 on the person's device's clock, or UTC's, from the day after it closed, while approval is on. Its key is the report and the day.
4. **Several at once are one push.** One says itself. Several of one kind say how many, such as "3 receipts filed". Several kinds say how many things need the person. The body names the first two and how many more. Tapping opens what they share, or Home. Each person's pushes carry one tag, so a newer one replaces an older one not yet looked at. A batch is what one sweep finds, so within five minutes.
5. **Never an amount (Q58).** Titles and bodies name a merchant, a trip, a report or a drive, never a sum. Titles are at most 80 characters and bodies 200, which the database holds too.
6. **A device is a subscription** (`push_subscriptions`): the push service's address, the browser's P-256 key and authentication secret, and the device's time zone. Up to ten a person (R-PUSH-DEVICES); past that, the oldest goes.
   - **Only push services' addresses are kept:** HTTPS, no port or credentials, at Apple's (`push.apple.com`), Google's, Mozilla's or Microsoft's. Any other is refused, so the server is never made to call somewhere else.
   - **A device is its person's alone.** Its address and keys are enough to push to that phone, so not even an owner, a finance admin or an auditor sees another's: a stricter `own_only` policy beside the usual own-records rules. Preferences and notifications are kept the same way.
   - The audit trail names the push service, never the address.
7. **Sent with the Web Push protocol** (RFC 8030), the payload encrypted for the device (RFC 8291, aes128gcm) so the push service can't read it, signed with the server's VAPID key (RFC 8292), kept a day for a phone that is off, with the `web-push` library.
   - Only a 404 or 410 means a subscription has ended, and the device is removed with its audit event.
   - Anything else, a 403 included, is tried again, up to three times (R-PUSH-TRIES). A 403 can come from our own signing, and dropping every device at once for it would be worse than a missed push.
8. **One VAPID key pair for the app, derived, not kept.** VAPID identifies the server, not a tenant. The pair is derived from the server's existing secret (`APP_ENCRYPTION_KEY`, else `SUPABASE_SECRET_KEY`) with HKDF and its own label, as the SecretBox's key is (ADR-0015). There is nothing new to set and no table of keys. Its subject is the production address Vercel gives every deployment.
9. **The service worker only shows and opens.** `public/sw.js` shows every push, as Safari requires, and on a tap opens only a path in the app, Home for anything else. It caches nothing, so every screen still comes fresh. Settings › Notifications renews the device with the server each time it opens, and replaces a subscription made with an older key.
10. **Notifications are kept 90 days** (R-PUSH-KEEP), sent or not.
11. **It ships behind `notifications.push`** (ADR-0032). Off, the sweep still moves the cursor, so nothing old is sent when it is switched on.

Out of scope: the native app's push (FR-PLT-08); a notification when an organization's AI or OpenRouteService key stops working, to its owners and finance admins, recommended and recorded as GAP-58 and #113; a list of past notifications in the app; quiet hours.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Each change sends its own notification, through the outbox | A dozen producers to change, each a place to forget, and no batching without a second step. The trail already holds every change, in order. |
| Native push (APNs) from the iOS app | There is no iOS app yet (FR-PLT-08). Web push reaches the Home Screen app today with no Apple developer account (Q57). |
| A push vendor (OneSignal, Firebase) | A new vendor and account for what the protocol does directly, and it would see every notification. |
| VAPID keys per organization, stored sealed | A table and a key to look after per organization, for an identity that is the server's, not the tenant's. |
| VAPID keys as Vercel settings | Two more secrets for the owner to set, and to keep in step with each other. |
| Send within a minute | Five minutes matches the relay's sweep, and the execution budget. A test is sent at once. |
| Drop a device on a 403 | A mistake in our signing would remove every device at once. |

## Consequences

### Positive

- **The phone says what needs the person**, the same day, without opening the app.
- **No producer changed,** and a change can't be notified twice.
- **Ten receipts are one push** saying ten.
- **Nothing new to configure:** no keys to set, no vendor account.
- **The lock screen never shows an amount.**

### Negative

- **Up to five minutes late,** where an event could be seconds. A test is sent at once.
- **About 8,600 more executions a month** on Inngest's free plan, as many as the relay's, about a third of the 50,000 between them (ADR-0014).
- **Only in the Home Screen app on an iPhone,** with iOS 16.4 or later. Safari in a tab can't get them; the page says how to add the app.
- **Rotating the server's secret changes the keys.** Each device then gets nothing until Settings › Notifications is opened on it again.
- **Tested against stand-ins, not Apple's service.** The request is checked byte for byte: encrypted so only the device's keys open it, signed with a VAPID JWT, TTL a day. Apple's answer codes follow its documentation for web push.

## Exit path / reversibility

- **The flag hides it,** and nothing is sent. The tables can stay.
- **A native app's push** is another sender behind the same notifications. The sweep, the kinds and the batching stay.
- **Another key** is one HKDF label away; each device subscribes again on its next visit to Settings › Notifications.

## Links

- FR-PLT-12, F-75, US-INBOX-03, Q57, Q58, GAP-58, backlog #112, #113
- [ADR-0003: Platform](0003-platform.md), [ADR-0014: Supabase Free plan](0014-supabase-free-plan.md), [ADR-0015: AI provider keys in the app](0015-ai-provider-keys-in-app.md), [ADR-0029: Expense reports](0029-expense-reports.md), [ADR-0032: Features switched per organization](0032-features-switched-per-organization.md), [ADR-0035: Each member's records kept to them](0035-own-records-and-invite-links.md)
- RFC 8030 (Web Push), RFC 8291 (message encryption), RFC 8292 (VAPID); Apple, "Sending web push notifications in web apps and browsers"
