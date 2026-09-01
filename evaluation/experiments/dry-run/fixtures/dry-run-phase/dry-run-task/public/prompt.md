# Dry-run fixture (NON_SCORING)

This is a synthetic, non-scoring fixture used only to exercise the experiment runner's plumbing
(workspace creation, participant execution, independent verification, cost/duration recording,
DVS/report serialization, cleanup). It is not part of the frozen 29-task suite
(`maf-suite-freeze-v1`) and must never be used to compute a scoring metric.

## Task

`src/greet.mjs` exports `greet(name)`. It currently returns `Hi, <name>` instead of the expected
`Hello, <name>!`. Fix `greet` so it returns `Hello, <name>!`.
