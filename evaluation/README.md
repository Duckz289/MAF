# Reconstructed evaluation layer

This directory contains the newly authored, local-only MAF benchmark reconstruction. It is not the
lost historical harness and must not be described as byte-equivalent to it.

## Corpus and isolation

- `phase-b/` contains 12 public task workspaces.
- `phase-c/` contains 17 public task workspaces across bands of 5, 7, and 5 tasks.
- `curator/` contains graders, references, alternatives, known-wrong candidates, attacks, and
  generalization probes.
- `lib/runner.mjs` materializes a fresh temporary workspace and launches a fresh grader process for
  every execution.
- The runner accepts only the generic `--workspace <path>` curator ABI, validates the result schema,
  applies timeouts, rejects unsafe overlays, and fails closed.
- Public workspaces are scanned for filename and content leakage. Curator material is not copied
  into candidate workspaces.

The protocol is `protocol.json`, version `2.0.0-reconstructed`. Frontier execution is disabled;
all commands below exercise only local deterministic fixtures.

## Validation commands

Run the complete reconstruction acceptance suite with:

```text
npm run validate:evaluation:full
```

The umbrella command covers ABI negatives and pilots; fixture, contract, and manifest checks;
Phase B; Phase C Bands 1-3; the Band 3 context audit; wrong and attack rejection; reference,
alternative, and probe acceptance; 14-round determinism stress; and cross-suite distinctness.

Individual commands are available as `validate:evaluation`, `validate:evaluation:phase-b`,
`validate:evaluation:phase-c:band12`, `validate:evaluation:phase-c:band3`,
`validate:evaluation:attacks`, `validate:evaluation:false-fail`,
`validate:evaluation:determinism`, and `validate:evaluation:cross-suite`.

This layer supplements the product benchmark runner in `src/benchmark/runner.ts`; it does not
weaken or replace product runtime boundaries.
