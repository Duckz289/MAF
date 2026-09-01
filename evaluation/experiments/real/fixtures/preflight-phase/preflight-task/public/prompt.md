# Real-provider preflight fixture (NON_SCORING)

This is a synthetic, non-scoring fixture used only to exercise the Protocol v2 real-provider
executor plumbing (controller-owned workspace creation, real Native/MAF participant execution
through the Claude Code CLI, independent verification, cost/duration/provenance recording,
cleanup). It is not part of the frozen 29-task suite (`maf-suite-freeze-v1`) and must never be used
to compute a scoring metric.

## Task

`src/format-name.mjs` exports `formatName(first, last)`. It currently returns `${first} ${last}`
instead of the expected `${last}, ${first}`. Fix `formatName` so it returns `${last}, ${first}`.
