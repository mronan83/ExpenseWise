# ADR-0004: iPhone technology

Build the Phase 3 iPhone app natively in SwiftUI, as a second client of the same API.

- **Status:** Accepted (decided by product owner)
- **Date:** 2026-09-30
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-04

## Context

Receipts get captured at a restaurant table, and miles happen in a car. A web app can use the camera and calculate a route, but it cannot detect drives in the background, and it cannot capture reliably offline ([C3](../01-vision-and-scope.md#c3-web-first-conflicts-with-where-the-work-happens)). The Phase 3 scope is a native iOS app with document-scanner capture, an offline queue, push and automatic mileage.

Business logic lives in the API, not in clients (AP1). The OpenAPI contract is the source of truth and generates the Swift client.

## Decision

Build the iPhone app in native SwiftUI, the best fit for the platform:

- VisionKit document scanning, Core Motion drive detection and background location are first-class.
- The app uses a Swift client generated from the OpenAPI contract, client-generated UUIDv7 IDs for offline-safe writes, and the identity provider's iOS SDK for browser-free auth.
- Push goes through APNs via the same notification service that sends email.
- Design tokens are exported to Swift with Style Dictionary, so both apps share one brand.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Expo / React Native, sharing TypeScript and some UI with the web app | Code sharing matters less when business logic already lives in the API, and the Phase 3 features depend on platform capabilities that are first-class in native code. |
| Progressive web app only | Cannot detect drives in the background or capture reliably offline (C3). |

## Consequences

### Positive

- Scanning, drive detection and background location use first-class platform APIs.
- No business logic is duplicated; the app is a client of the same API.

### Negative

- A second language and a second UI codebase. Nothing is shared with the web app except the API contract and design tokens.
- Web-first UX debt can surface when iOS arrives (R3: medium likelihood, medium impact). Mitigations: a mobile-first PWA, OpenAPI contract tests and shared design tokens.
- Old app versions live for months, so each API version carries a 6-month deprecation window and CI runs contract tests against the oldest supported version.

## Exit path / reversibility

The app holds no business rules, so replacing it is a client rewrite only. The API, the contract and the design tokens stay. An Expo / React Native client could consume the same API if the trade-off changes. Swift work starts in Phase 3 (weeks 18–30). Until then, this decision shapes only the API contract and the token export.

## Links

- [How the iPhone app slots in](../05-architecture.md#610-how-the-iphone-app-slots-in)
- [Design system and accessibility](../04-app-design.md#54-design-system-and-accessibility)
- [Roadmap](../07-roadmap.md), [risk register](../08-risk-register.md): R3
- [ADR-0002](0002-architecture-style.md), [ADR-0005](0005-identity.md)
