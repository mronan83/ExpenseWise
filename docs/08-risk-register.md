# Risk register

What is most likely to hurt us, with likelihood, impact and mitigation (blueprint §10).

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | Scope creep from "full featured" | High | High | [Capability map](02-capability-map.md) as the scope contract, phase exit criteria, and every addition treated as a decision |
| R2 | Extraction accuracy on hard receipts | Medium | High | Eval set, per-field confidence gating, the Needs review inbox and model-tier escalation |
| R3 | Web-first UX debt when iOS arrives | Medium | Medium | Mobile-first PWA, OpenAPI contract tests and shared design tokens |
| R4 | Cross-tenant data exposure | Low | Critical | RLS plus application checks, cross-tenant tests in CI, and a security review at every phase exit |
| R5 | Vendor lock-in | Medium | Medium | Adapters at every vendor boundary, standard Postgres and S3, and an exit path in each ADR |
| R6 | Unit economics: AI, feeds and infrastructure cost per user | Medium | Medium | Cost per receipt tracked from Phase 0, prompt caching, batch re-processing, and model tier chosen on data |
| R7 | Self-review blind spots: one builder, four roles | High | Medium | Independent automated gates, the product owner's acceptance and promotion gates, adversarial review passes and docs-as-code |
| R8 | Money-movement regulation once we pay people | Low | High | Payouts only through a licensed partner; ExpenseWise never holds funds |

## Related

- [Vision and scope](01-vision-and-scope.md): the challenges behind R1, R3 and R7.
- [Delivery lifecycle](06-delivery-lifecycle.md): the gates behind R4 and R7.
- [ADR index](adr/README.md): exit paths behind R5.
