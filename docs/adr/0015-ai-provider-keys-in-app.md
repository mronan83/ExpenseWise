# ADR-0015: AI provider keys configured in the app

Each organization stores its own Anthropic and OpenAI keys in ExpenseWise, encrypted and checked with the provider on save, instead of in deployment environment variables.

- **Status:** Accepted (decided by product owner); point 7 amended by [ADR-0020](0020-openai-fallback-reader.md)
- **Date:** 2026-10-02
- **Deciders:** Product owner; Claude (principal architect)
- **Decision register:** D-17
- **Related:** [ADR-0006](0006-receipt-extraction.md) (receipt extraction), [ADR-0013](0013-supabase-platform.md) (Supabase platform), [D-15](../07-roadmap.md#phase-1-plan) (email and password sign-in)

## Context

Receipt extraction needs an AI provider credential ([ADR-0006](0006-receipt-extraction.md)). Supplying it as an environment variable failed repeatedly: in cloud session settings, in a fresh session and through GitHub. Each attempt cost the product owner time without telling them what was wrong. The product owner decided that keys are entered in the app.

That is also where they belong as the product grows. A key spends money with a provider on someone's account, so it belongs to an organization, not to a deployment. Teams will bring their own keys (ADR-0001's small teams). And a settings screen can check a key the moment it is entered, which an environment variable never does.

## Decision

1. **Per-organization keys.** Each organization stores at most one key per provider (Anthropic, OpenAI) in `ai_provider_keys`. It is a tenant table under the same forced row-level security as every other (migrations 0004 and 0005).
2. **Encrypted at rest.** Keys are sealed with AES-256-GCM. The key is derived with HKDF-SHA-256 from `APP_ENCRYPTION_KEY` when set, otherwise from `SUPABASE_SECRET_KEY`, which every deployment already has, so no new setting is needed. Each ciphertext is bound to its organization and provider as additional authenticated data, so a ciphertext copied to another row won't open. Database backups ([ADR-0014](0014-supabase-free-plan.md)) therefore hold ciphertext only.
3. **Never returned.** The API accepts a key, but never sends one back: only its last four characters, how the provider accepted it, and when it last worked. Logs, error tracking and audit events never carry it.
4. **Checked on save.** A key is stored only after a free call to the provider (listing models) succeeds. Anthropic issues both API keys (sent as `x-api-key`) and OAuth-style tokens (sent as a bearer token), so both are tried and the working scheme is stored with the key. A **Test** action repeats the check at any time.
5. **Owner and finance admin only, and audited.** Only those two roles can set, test or remove a key. Each change appends an audit event in the same transaction.
6. **Sign-in comes forward.** The settings screen needs a signed-in owner, so this change brings email and password sign-in (D-15) forward. The owner's one-person organization is created on first sign-in. A read-only `own_memberships` policy lets the API find the caller's organizations by user id before an organization is chosen.
7. **OpenAI keys are stored, not yet used.** *Amended by [ADR-0020](0020-openai-fallback-reader.md): an OpenAI key now reads a receipt when neither Claude model can.* Extraction stays on Claude (ADR-0006). Using OpenAI needs an OpenAI extractor behind the same `Extractor` interface, and a spike run that compares it on the eval set.

Out of scope until increment 1's multi-factor work: requiring step-up (aal2) for key changes, which ADR-0013 asks of admin actions.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Environment variables per deployment | They failed in practice here. They also can't be per organization, can't be checked when entered, and need a redeploy to change. |
| Supabase Vault | Keys would live in Supabase's managed encryption, which plain Postgres in CI and local development doesn't have. That deepens platform concentration (R9) for a small gain. |
| A cloud key management service (AWS KMS, Google Cloud KMS) | It is the stronger option, but it means another vendor, another account and another credential, for one user. The exit path below keeps it open. |
| Storing keys in plain text | One leaked backup or database read would spend the organization's money. |

## Consequences

### Positive

- No environment variables: the owner pastes a key, sees at once whether it works, and can replace it in seconds.
- Organizations can bring their own keys, which is the model teams will expect.
- Backups, dumps and the database hold only ciphertext bound to each row.

### Negative

- **Rotating the source secret makes stored keys unreadable.** That secret is `SUPABASE_SECRET_KEY` unless `APP_ENCRYPTION_KEY` is set. **Test** then says so, and the keys are entered again. Set `APP_ENCRYPTION_KEY` before rotating Supabase keys if that would be inconvenient.
- **The server can decrypt every key.** A compromise of the running application or of its secret exposes them. Contained by the same controls as tenant data: row-level security, the runtime role, no plaintext in logs, and least-privilege keys at the provider (set a spend limit there).
- **Until multi-factor sign-in ships, a stolen password lets someone replace or remove keys.** Contained by sign-ups being off and a single owner, and closed by step-up MFA in increment 1.
- **One more place holds secrets.** It is covered by the tenancy tests, the audit log and the security review at phase exit.

## Exit path / reversibility

`createSecretBox` is the only code that touches the encryption key. Moving to a key management service means a new box implementation, plus a one-off job that opens each row with the old box and seals it with the new one. The `v1.` prefix on every ciphertext marks the format. Dropping the feature means deleting the table's rows and falling back to an environment variable read by the extractor.

## Links

- [ADR-0006](0006-receipt-extraction.md), [ADR-0013](0013-supabase-platform.md), [ADR-0014](0014-supabase-free-plan.md), [ADR-0001](0001-target-segment-and-tenancy.md)
- [Runbook: Supabase Auth and AI provider keys](../runbooks/environment-setup.md#4-supabase-auth-needed-for-sign-in-in-phase-1)
- [Risk register](../08-risk-register.md): R4, R9
