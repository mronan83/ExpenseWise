# Security policy

ExpenseWise handles financial records and receipt images, so security reports get priority.

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** button on the Security tab of this repository. Do not open a public issue.

Include what you found, how to reproduce it and the impact you expect. You will get an acknowledgement within 3 working days.

## Scope and standards

- The build standard is OWASP ASVS Level 2 (docs/adr/0010-residency-and-compliance.md).
- Tenant isolation is enforced by Postgres row-level security and tested in CI (packages/db/test).
- Secrets never live in the repository. CI runs gitleaks on every push.
- Receipt data used for evaluation never goes in git (see `.gitignore` and docs/adr/0012-eval-set-composition.md).
