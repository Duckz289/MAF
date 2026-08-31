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

---

# Independent audit repair (`bb32652`)

A second independent audit was run against the reconstructed snapshot at
`bb3265275cd1291e84807c7c453d9bec72229884`. It returned verdict
`NEEDS_MAJOR_RECONSTRUCTION_REPAIR`. The repair is tracked on branch
`repair/independent-audit-bb32652-v1` and is documented here without rewriting the history
above: the first audit failed and this is the record of that failure and its remediation.

## Audit findings and repairs

### Grader repair
The independent audit reproduced **15/15 known false-pass defects** (invalid implementations that
graded PASS) and **2/2 known false-fail defects** (correct implementations that graded FAIL). The
grader blades in `evaluation/curator/phase-b/graders.mjs` and
`evaluation/curator/phase-c/graders-band12.mjs` were repaired. The regression matrix covering
all 29 tasks was green after the repairs.

### Fail closed on missing candidate artifacts
A bug was reproduced where a missing `wrong` or `attack` candidate could silently fall back to the
pristine run and still satisfy an expected `FAIL`. The matrix logic was extracted and a permanent
regression test added. A missing required candidate artifact now fails closed as `INVALID` and is
never counted as an expected `FAIL` through a pristine fallback.

### ABI / containment hardening
- Timeout and cleanup failures were reproduced as escaping uncontrolled exceptions; a grader
  timeout (including one holding a live descendant) is now classified `INVALID` without throwing.
- Live-descendant cleanup issues and intermediate junction/link overlay escapes were reproduced and
  closed. The overlay resolver rejects traversal, mixed/absolute separators, drive-relative paths,
  and intermediate-overlay symlink/junction escapes; contained dot-segment paths remain accepted.
- The curator runner was hardened and permanent ABI regression tests added (`evaluation/abi-tests`).

### Leakage hardening
The old lexical detector missed **10/10 planted leaks**. The new detector reports **14/14 planted
leaks with 0 false positives**. Permanent leakage tests cover planted filenames and planted content
(`answer.mjs`, `expected-patch*`, `solution`, `correct fix`, `reference`, `grader`, `curator`,
`hidden assertion`) plus legitimate fixture files being left unflagged. Detection is
lexical/content-based; no semantic leakage detection is claimed.

### Validation measurement repair
Hard-coded `PASS` claims were removed and replaced with measured evidence. PID-uniqueness logic was
corrected after PID reuse was observed, and cross-suite validation was made measurement-based.

### DVS / protocol wiring
The evaluation protocol types and metrics were rewritten, a production bridge was added, the
benchmark runner was wired into the protocol layer, and production integration tests were added
(10/10 wiring tests PASS; protocol-wiring and DVS-semantics suites: 32/32 PASS). Repaired
accounting: two `$100` failures followed by a `$1` DVS report `costPerDvsUsd = $201`, unknown cost
remains unknown/partial and is never silently treated as `$0`, invalid runs are excluded/separated
from the valid-run DVS denominator, and both-invalid arms are represented explicitly as both
invalid. Infrastructure failure maps to NOT-DVS.

### Fresh corpora
- **Fresh false-pass attacks**: 29 contract-derived attacks, one per task, authored independently
  of the audit. **29/29 invalid fresh attacks rejected.**
- **Fresh false-fail alternatives**: 12 structurally different correct implementations authored
  from the public prompts, each declaring the `freedom` it exercises. **12/12 PASS.**

## Final measured validation

| Gate | Result |
| --- | --- |
| Known false-pass retest | 15/15 `FAIL` |
| Known false-fail retest | 2/2 `PASS` |
| Fresh false-pass attacks | 29/29 `FAIL` |
| Fresh false-fail alternatives | 12/12 `PASS` |
| Combined audit regression | 58/58 correct |
| ABI / negative tests | 45/45 PASS (incl. timeout, descendant cleanup, overlay, missing-artifact fail-closed) |
| Full 29-task curator matrix | pristine FAIL / reference PASS / wrong FAIL / alternative PASS per task |
| Determinism stress | 145 cases x 14 rounds = 2,030 executions, all stable; cwd-independent; 2,030 distinct workspaces, 0 reused |
| Leakage | planted 14/14 detected, 0 false positives; lexical/content only |
| Cross-suite audit | 29/29 unique behavior signatures; no copied attackers/references, graders, or fixture reskins over limits |
| Band 3 context | 5 `CONTEXT_TEST_STRONG`, 0 WEAK, 0 `NOT_A_CONTEXT_TEST` (derived from module-reach, owner-path, decision-point and decoy measurements) |
| Phase-c protocol/DVS wiring | 32/32 PASS |

`npm test`: 1,122 passed, 8 skipped (85 files passed, 4 skipped). `typecheck`: PASS. `build`:
PASS. `smoke`: PASS (not gated in the combined repository run below). `format:check`: PASS.
`lint`: FAIL, 20 warnings + 6 infos — intentional unused parameters in adversarial/pristine
fixtures and test string-literal style diagnostics. `compose:check`:
`ENVIRONMENT_UNAVAILABLE` — Docker Compose is not installed in this environment and no checksum-
verified Compose bootstrap is configured, so it was not fabricated. `npm run validate` therefore
does not complete end to end in this environment.

## Repair checkpoints

| Commit | Checkpoint |
| --- | --- |
| `2ab107b` | Reproduce independent-audit defects |
| `c017f05` | Repair contract-derived grader validity |
| `3bde30e` | Harden curator failure and filesystem isolation |
| `611fb1c` | Strengthen benchmark leakage validation |
| `a6e9405`, `806bc02` | Rebuild Band 3 context validity (1/2, 2/2) |
| `2d12f70` | Make reconstruction validation evidence-driven |
| `70306f1` | Wire trust semantics and correct DVS accounting |
| `39dd76f` | Fail closed on missing candidate artifacts |
| `0343b65` | Add fresh audit regression corpora (attacks + alternatives) |
| *next* | Final repair validation/documentation record (this section) |

No Native or MAF frontier benchmark agent, paid participant, or performance comparison was run as
part of this repair. The repaired suite still requires a second independent audit.

`INDEPENDENT_REAUDIT_REQUIRED: YES`
`FRONTIER_MODELS_EXECUTED: NO`
