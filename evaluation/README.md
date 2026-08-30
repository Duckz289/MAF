# Reconstructed evaluation layer

This directory contains a new, local-only evaluation protocol and typed metric semantics. It is not the lost historical harness and must not be described as byte-equivalent to it.

- Protocol: `protocol.json`, version `2.0.0-reconstructed`.
- Runtime semantics: `src/evaluation/types.ts` and `src/evaluation/metrics.ts`.
- Frontier execution is intentionally disabled; tests use synthetic records only.

The existing `src/benchmark/runner.ts` remains the MAF product benchmark runner. The reconstructed layer does not weaken or rewrite it: it adds independent candidate/run validity, grader precedence, infrastructure classification, paired outcomes, and explicit unknown-cost handling.
