# Evals

The extraction eval harness behind the Phase 0 spike ([ADR-0006](../docs/adr/0006-receipt-extraction.md), [ADR-0012](../docs/adr/0012-eval-set-composition.md)). It measures how often each Claude tier reads a receipt correctly, how often a wrong read would skip human review, and what each read costs.

## Data

Documents and results are data, so git ignores `evals/data/` and `evals/results/`. `pnpm --filter @expensewise/evals data` rebuilds the cache from two layers:

| Layer     | Source                                                                                                                                                             | License                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Public    | [CORD v2](https://huggingface.co/datasets/naver-clova-ix/cord-v2) test split: Indonesian receipts with labelled totals, subtotals and taxes                        | CC BY 4.0, Clova AI Research |
| Synthetic | Hotel folios, airline e-tickets and US restaurant card slips with known answers, generated from a seed and rendered by Chromium as PDFs or tilted, softened photos | Ours                         |

SROIE was planned for the public layer, but its usual mirrors carry code rather than the receipts, so synthetic restaurant receipts cover merchant, date, tip and card fields instead. Real captures join from Phase 1 on.

## Run

```sh
pnpm --filter @expensewise/evals data                   # fetch and generate the documents
pnpm --filter @expensewise/evals spike -- --dry-run     # prove the harness with known answers, free
pnpm --filter @expensewise/evals spike                  # print the cost estimate; sends nothing
pnpm --filter @expensewise/evals spike -- --yes         # run all four tiers (needs ANTHROPIC_API_KEY)
```

Options: `--models fable,opus,sonnet,haiku`, `--sources cord,synthetic-folio,…`, `--limit N` per source, `--concurrency N`.

Each run writes `results.jsonl` (every call's model, prompt version, latency, tokens, cost, output and score) and `report.md` under `evals/results/<timestamp>/`.

## What the report measures

- **Fields correct:** money compares integer minor units; merchants match loosely (case, punctuation, "&" vs "and").
- **Would skip review:** merchant, date, currency and total came back high-confidence and every value parsed, so the pipeline would file the expense as Ready.
- **Wrong but skipped review:** documents filed as Ready with a wrong field. This is the number that decides whether a tier is safe; accuracy alone is not.
- **Confidently wrong fields:** wrong fields marked high confidence, which the review gate cannot catch.
