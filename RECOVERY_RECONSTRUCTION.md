# MAF post-36791bc benchmark reconstruction

This branch is a newly authored reconstruction built from trusted checkpoint
`36791bc296824ff9bdc2d04c1a3bed46b7bd6362`. It is not a byte-for-byte recovery of the
lost benchmark and does not recreate lost history, results, or historical commit identities.

The original post-checkpoint benchmark implementation was lost. A first reconstruction was then
successfully authored and validated in an ephemeral Linux workspace, but that workspace was lost
before its commits could be pushed or exported. This persistent Windows branch is therefore a
second reconstruction. Its behavioral target comes from the recorded validation report of that
successful first reconstruction, followed by a fresh audit of the actual Windows repository.

The inaccessible Linux SHAs `98e23fc`, `7bf0929`, `8628c6e`, `8cadd74`, `9028cab`, `fa51e22`,
`19d2044`, `26437cd`, and `9f99713` are forensic references only. None is impersonated or recreated,
and no SHA or byte equivalence is claimed.

- Branch: `recovery/rebuild-post-36791bc-v2`
- Protocol: `evaluation/protocol.json`, version `2.0.0-reconstructed`
- Phase B: 12 executable behavioral tasks
- Phase C: 17 executable behavioral tasks: Band 1 = 5, Band 2 = 7, Band 3 = 5
- Frontier execution: prohibited by the reconstructed protocol and not performed

## Reconstruction checkpoints

| Commit | Checkpoint |
| --- | --- |
| `a209b9c` | Curator ABI, isolation, fail-closed behavior, and pilot cases |
| `041d01a` | Phase B private corpus and behavioral matrix |
| `e4fd776` | Phase C Band 1 and Band 2 corpus |
| `7890a09` | Symptom-only Phase C Band 3 corpus and context audit |
| `c999e10` | Adversarial and false-fail hardening |
| `3d4c10a` | Deterministic isolated stress execution |
| `2f3386c` | Cross-suite distinctness and leakage audit |

Checkpoint 8 is the final validation/documentation commit containing this record. Its SHA is
reported after creation because a commit cannot contain its own identity.

## Final acceptance evidence

The final acceptance run is performed from scratch after the last artifact modification. The
expected-outcome matrix is:

| Candidate or gate | Cases | Required result |
| --- | ---: | --- |
| Curator ABI negatives and pilots | 18 | 18 pass |
| Pristine workspaces | 29 | 29 correctly fail grading |
| Reference implementations | 29 | 29 pass grading |
| Known-wrong implementations | 29 | 29 correctly fail grading |
| Alternative correct implementations | 29 | 29 pass grading |
| Second-style attack implementations | 29 | 29 correctly fail grading |
| Combined false-pass challenge | 58 | 58 wrong or attack candidates rejected |
| False-fail challenge | 83 | 58 reference/alternative plus 25 probes accepted |
| Band 3 context orientation | 5 | 5 `CONTEXT_TEST_STRONG`; none weak or invalid |
| Determinism stress | 2,030 executions | 145 cases x 14 rounds, all stable |

The stress run interleaves rotated and reversed orders at concurrency 4 and splits execution
between repository and evaluation working directories (1,015 executions each). It checks stale
module caches, shared temporary state, order sensitivity, current-working-directory dependence,
synchronization, filename and content leakage, workspace materialization, and hidden-artifact
isolation.

Repository acceptance is also gated by 84 passing Vitest files and 1,095 passing tests, with the
existing four skipped files and eight skipped tests, plus separate successful runs of formatting,
linting, typechecking, building, compose validation, smoke validation, and the complete `npm run
validate` command.

## Provenance and limits

Only this reconstructed corpus and its local validation results are claimed. No Native or MAF
frontier condition was run, so this work reports no benchmark performance, DVS, false-safe, cost,
or comparative condition result. Curator graders, correct overlays, known-wrong overlays, attacks,
and probes remain local validation instruments and must never be exposed to an evaluated
condition.

An independent frontier audit is still required before using this reconstruction to make research
claims.

`INDEPENDENT_FRONTIER_AUDIT_REQUIRED: YES`
