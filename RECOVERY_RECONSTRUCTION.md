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
`lint`: PASS (exit code 0) with 20 warnings + 6 infos — intentional unused parameters in
adversarial/pristine fixtures and test string-literal style diagnostics. This line previously read
`FAIL`, which was wrong: `npm run lint` exits 0 and Biome reports those diagnostics as warnings and
infos, not errors. The second independent audit established the correct exit code and the record is
corrected here rather than quietly restated. `compose:check`:
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

---

# Independent Audit #2 repair (`5084aba`)

A **second** independent audit was run against the repaired snapshot at
`5084aba184f12f420fbcab4b1f9428a8f10988b5` — that is, against the result of the Audit #1 repair
documented above. It failed too. This section records that failure and its remediation, on branch
`repair/second-audit-root-causes-v1`.

The history is deliberately kept whole:

> reconstruction → **Audit #1 failed** → repair #1 → **Audit #2 failed** → repair #2 → *third audit
> still required*

Nothing above this line has been deleted or softened. Two of the "final measured validation" rows in
the Audit #1 section were later shown to be wrong, and they are corrected here rather than edited
there: **Band 3 was not 5 STRONG**, and the **DVS wiring was not sound**.

## Root cause 1 — the production trust pipeline verified nothing

The most serious finding. `src/evaluation/benchmark-bridge.ts` derived all three trusted protocol
fields from the participant's own execution report:

    hiddenGrader        <- sample.verificationResult === "VERIFIED"
    regression          <- sample.verificationResult === "VERIFIED" && !verifierFailures
    candidateIntegrity  <- sample.filesChanged.length > 0

Reproduced through the real `BenchmarkRunner.compare` path: a participant returning
`verificationResult: "VERIFIED"` with the fabricated file list
`["src/this-file-was-never-written.mjs"]` produced **2/2 DVS**, with `hiddenGrader: PASS`,
`regression: PASS` and `candidateIntegrity: VALID`. No independent grader ran; none was reachable
from production. The suite's real hidden graders sat in `evaluation/curator` and were never on the
DVS path. Audit #1's "32/32 protocol wiring PASS" was measuring a pipeline that trusted its subject.

**Repair.** `src/evaluation/independent-verification.ts` defines a controller-side verifier port.
Correctness evidence now carries an `evidenceSource`, and `isDvs` requires it to be `INDEPENDENT`.
Absence of verification resolves to `NOT_CHECKED` — a new `EvidenceOutcome` distinct from `UNKNOWN`,
meaning "no check ran" rather than "a check reached no verdict" — and cannot be a DVS. The runner's
default verifier declines, so a benchmark wired without one yields no successes rather than
unverified ones. Participant claims survive as `selfReported` diagnostics and as `claimedDone` for
false-safe detection; they establish nothing.

`src/evaluation/curator-verifier.ts` puts the suite's actual graders on the production path. It runs
after the participant, against a workspace the **controller** allocated
(`BenchmarkTask.candidateWorkspaces` — part of the task, so a participant cannot name or fabricate
the path):

| Trusted field | How it is established |
| --- | --- |
| `candidateIntegrity` | diff the controller's workspace against the pristine fixture, check containment, parse changed modules with `node --check` |
| `hiddenGrader` | invoke the task's curator grader out of process |
| `regression` | load every module the candidate ships and run every public entrypoint to a clean exit |

The regression check is a **smoke regression over the fixture's own program**, not a full project
test suite. `protocol.json` says so rather than implying more.

Semantics are stated explicitly: the participant's claim is neither necessary nor sufficient. A
participant reporting failure over a candidate the independent grader passes **is** a DVS; one
reporting success over a candidate the grader fails is not. Infrastructure failure still precedes
all of it.

## Root cause 2 — graders observed final state, fixed values, shallow boundaries

Six false-passes, all reproduced first as `evaluation/regression/candidates/audit2-false-pass`:

| Task | Hole |
| --- | --- |
| `inventory-orientation-task` | live stored object mutated then restored, never touching `saveItem` |
| `b2-pending-write-visibility` | defers only the key names the grader uses |
| `b2-bulk-op-tenant-bypass` | `startsWith` instead of equality on tenants |
| `b2-derived-aggregate-consistency` | `state.total` written then restored |
| `b2-partial-validation-mutation` | nested `tags` pushed then popped |
| `b2-record-shape-migration-loss` | nested `metadata` mutated then restored |

**6/6 graded PASS before; 6/6 FAIL after.**

**Repair, generalized rather than patched six times.** `trackWrites` records writes at any depth with
the path they happened on; `deepFreeze` gives the same observation where a candidate may legitimately
`structuredClone` its input; `privateValues` generates deterministic identifiers from a recorded
seed so graders stop asserting against literals a candidate can special-case. Generalization was
applied beyond the two flagged graders — refund order identities and the migration's unknown field
names are private too. The inventory store probe additionally observes writes into the live stored
object, and — after a round-2 attack found the gap — `defineProperty` as well as assignment.

**Discount rounding, resolved publicly.** The audit found `toFixed` rounding disagreeing with
`Math.round(x*100)/100`. Measured: **3 of 360** swept combinations land exactly on a half cent
(9.975, 29.025, 85.785) where both answers are defensible. The grader now checks the property the
prompt states — at most two decimals, within half a cent of the exact value — and the prompt says so
explicitly. The reference's floating-point algorithm is not the specification.

## Root cause 3 — Band 3 measured the wrong thing

The repository reported **5 STRONG**; Audit #2 measured **0 STRONG, 5 WEAK**.

The analyzer counted ESM import-graph hops and module out-degree and called them investigation
difficulty. A coding agent does not breadth-first search an import graph: it reads the symptom, greps
the vocabulary the report gives it, and opens what matches. A six-hop chain one grep collapses is not
a context test.

The analyzer now measures whether any realistic search term from the **public prompt** reaches the
owner (tried against every file, no longer filtered by owner metadata); how far the owner sits from
the nearest *other* file the symptom vocabulary surfaces; how many steps offer a genuine choice
between symptom-plausible modules; and whether declared decoys are reachable **and**
symptom-plausible. Rerun against the pre-repair fixtures it independently reproduced the auditor's
**0 STRONG, 5 WEAK**. Writing it also exposed a flaw in the new metric itself — symptom terms were
matched as raw substrings, so `strategy` counted as a mention of `rate`; matching is now word-bounded.

All five fixtures shared one design defect: the vocabulary the prompt hands a reader appeared in the
defect owner. Each now separates the two — the modules that *exhibit* the symptom keep the report's
words, and the module that *causes* it speaks a different vocabulary, reached by following behaviour
rather than by searching. The split differs per task so the five stay structurally distinct.

**Measured result, reported as measured:**

| Task | Class | Depth | Decisions | Credible decoys | Owner grep-surfaced |
| --- | --- | ---: | ---: | ---: | --- |
| `notification-settings-regression` | `CONTEXT_TEST_STRONG` | 3 | 2 | 2 | no |
| `discount-result-regression` | `CONTEXT_TEST_STRONG` | 3 | 4 | 2 | no |
| `subscription-price-mismatch` | `CONTEXT_TEST_STRONG` | 3 | 3 | 4 | no |
| `task-update-duplication` | `CONTEXT_TEST_WEAK` | 2 | 3 | 2 | no |
| `completion-state-regression` | `CONTEXT_TEST_WEAK` | 2 | 3 | 5 | no |

**3 STRONG, 2 WEAK, 0 `NOT_A_CONTEXT_TEST`.** The two weak tasks are one hop below the declared
depth threshold of 3. They are reported weak rather than repaired by lowering the threshold or by
renaming a module's honest word — "publish" is the word the `task-update-duplication` prompt itself
uses, and dodging the metric with a synonym would be the failure this checkpoint exists to fix.

## Root cause 4 — metrics and unmeasured claims

`BenchmarkReport.metrics.costPerVerifiedSuccess` sat beside `evaluation.cost.costPerDvsUsd` and could
be read as the same quantity. It is not: one is the arithmetic mean over samples that *claimed*
success, the other is total cost of all runs in scope divided by *independently verified* successes.
The benchmark fields are renamed to say what they are — `selfReportedVerifiedRate`,
`meanCostOfVerifiedSuccessesUsd`, `selfReportedSuccessesWithKnownCost` — and both types carry notes
on which question each answers.

`validate-fixtures.mjs` printed `hiddenIsolation`, `leakage` and `deterministicPolicy` as literal
`"PASS"`; two were measured but reported as literals and the third was never measured there at all.
`validate-contracts.mjs` printed an unconditional `status: "PASS"` and carried its own leakage regex
that matched `solution` inside `resolution-policy`. Both now report scanned/finding counts, state
`NOT_CHECKED` where nothing was measured, and share the single tokenizing leakage detector.
`evaluation/phase-c/README.md` claimed all five Band 3 tasks were STRONG; it now states the measured
result.

Leakage vocabulary was broadened (28 path terms, 14 path phrases, 51 content phrases) while the claim
stays exactly what it is: **lexical** filename and content matching, not semantic analysis.

## Adversarial rounds after the repair

A second round was authored *after* the repairs, against the surfaces they created, with a recorded
seed (`evaluation/regression/index.json`, `round2Seed: 0x2a0d17`). Two of its results were findings
rather than confirmations:

* `inventory-defineproperty-write` found a real gap — the store probe trapped `set` and `delete` but
  not `defineProperty`. Fixed.
* `patch-clone-and-return`, a *correct* alternative that validates against `structuredClone(record)`,
  **failed** — because `structuredClone` cannot clone a proxy and the deep write observer is one.
  That was a hidden requirement introduced by the repair itself. The grader now runs each
  invalid-patch case twice: once with a plain record, which holds every candidate to the outcome, and
  once with the observing record; a candidate that clones is judged on the first pass and the check
  says so in its message.

One authored attack, `layer-merge-two-layer-assumption`, turned out to be **correct** for every chain
shape the fixture produces — a bad attack, not a grader hole. It was replaced rather than counted.

## Final measured validation (Audit #2 repair)

| Gate | Result |
| --- | --- |
| Audit #2 false-pass retest | 6/6 `FAIL` (were 6/6 `PASS`) |
| Audit #1 false-pass retest | 15/15 `FAIL` |
| Audit #1 false-fail retest | 2/2 `PASS` |
| Fresh attacks (round 1) | 29/29 `FAIL` |
| Fresh alternatives (round 1) | 13/13 `PASS` |
| Fresh attacks (round 2) | 12/12 `FAIL` |
| Fresh alternatives (round 2) | 8/8 `PASS` |
| Combined regression corpora | **85/85 correct** across seven corpora |
| Production trust boundary | 17/17 PASS, incl. all seven required cases and five against the real curator verifier |
| Protocol / DVS semantics | 25 unit + 10 wiring tests PASS |
| ABI / negative tests | 45/45 PASS |
| Full 29-task curator matrix | 170/170, deterministic |
| Determinism stress | 145 cases × 14 rounds = 2,030 executions, 0 failures; 145/145 order-stable; 0 cwd-divergent; 2,030 distinct workspaces, 0 reused; 0 cleanup failures |
| Band 3 orientation | 3 STRONG, 2 WEAK, 0 `NOT_A_CONTEXT_TEST` — measured, not declared |
| Cross-suite audit | measured; no reskins, copied graders or grader-aware attacks over limits |

## Repository validation (Audit #2 repair, run after the last modification)

| Command | Result |
| --- | --- |
| `npm test` | **PASS** — 1,146 passed, 8 skipped (86 files passed, 4 skipped) |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS**, exit code 0 — 21 warnings, 6 infos (intentional unused parameters in adversarial/pristine fixtures, and test string-literal style diagnostics) |
| `npm run format:check` | **PASS** |
| `npm run build` | **PASS** |
| `npm run smoke` | **PASS** |
| `npm run compose:check` | **ENVIRONMENT_UNAVAILABLE** — Docker Compose is not installed here and no checksum-verified Compose bootstrap is configured, so it was not fabricated |
| `npm run validate` | **INCOMPLETE_ENVIRONMENT** — `format:check`, `lint`, `typecheck`, `test` and `build` all pass; the chain then stops at `compose:check` for the reason above |
| `npm run validate:evaluation` | **PASS** — ABI tests, pilots, fixture/contract/reconstruction validation and the 85-candidate audit regression |

Evaluation harnesses, each run directly after the last artifact modification:

| Harness | Result |
| --- | --- |
| `node --test evaluation/abi-tests/*.test.mjs` | 45/45 PASS |
| `evaluation/run-curator-matrix.mjs` (29 tasks, all candidates) | 170/170, 0 failures, deterministic, 0 missing artifacts |
| `evaluation/run-audit-regression.mjs` (7 corpora) | 85/85 correct |
| `evaluation/run-determinism-stress.mjs --rounds 14` | 2,030 executions, 0 failures; 145/145 order-stable; 0 cwd-divergent; 2,030 distinct workspaces, 0 reused; 0 materialization or cleanup failures |
| `evaluation/audit-band3-context.mjs` | 3 STRONG, 2 WEAK, 0 `NOT_A_CONTEXT_TEST` |
| `evaluation/audit-cross-suite.mjs` | 0 failures |
| `evaluation/validate-fixtures.mjs` | 235 files scanned, 0 findings; `deterministicPolicy` and `semanticLeakage` reported `NOT_CHECKED` |
| `evaluation/validate-contracts.mjs` | 29 tasks, 235 files scanned, 0 findings |
| `evaluation/run-abi-pilots.mjs` | 0 failures |

## Repair #2 checkpoints

| Commit | Checkpoint |
| --- | --- |
| `d97f24a` | Enforce independent production verification |
| `4ee4676` | Strengthen behavioral observation and generalization |
| `a3301a9` | Redesign Band 3 for real orientation difficulty |
| `fd1901d` | Unify metrics and validation evidence |
| `5efdb61` | Second adversarial and false-fail round |
| *next* | Final repair validation/documentation record (this section) |

No Native or MAF frontier participant, paid benchmark model, or performance comparison was run as
part of this repair. Two audits have now found this suite unfit to freeze; nothing here should be
read as evidence that a third will not.

`INDEPENDENT_REAUDIT_REQUIRED: YES`
`FRONTIER_MODELS_EXECUTED: NO`

# Pre-freeze small repairs (`repair/pre-freeze-small-fixes-v1`)

A **third** audit was run against the Audit #2 repair above, at `62277b59b7f1f3adc0e34f05c4bb1292633356b0`.
Its continuity was mixed -- the auditor of record for that pass stopped between turns, and the
progress it had reported could not be independently recovered from any session, task tracker, or
scratch artifact; what follows was re-derived fresh rather than trusted from an unverifiable prior
claim. That audit found the production trust boundary and the executor-self-report exploit still
correctly blocked, all six Audit #2 grader holes still closed, and no critical trust-boundary
bypass -- but it did find three small, scoped, real defects, reproduced empirically rather than
asserted. This section records their repair. The history stays whole:

> reconstruction → Audit #1 failed → repair #1 → Audit #2 failed → repair #2 → **Audit #3 found three
> scoped gaps** → this repair

## Gap 1 — stale-cache-invalidation-bug grader never tested a patch carrying its own id

`stale-cache-invalidation-bug`'s hidden grader exercised `updateUserProfile(userId, patch)` only
with patches that never carried an `id` field of their own, so a candidate invalidating
`userProfileCacheKey(patch.id ?? userId)` -- or any code shape reading a patch-influenced id before
the real `userId` is enforced -- passed while leaving the actual target's cached profile stale.
**Reproduced and repaired, generalized rather than patched to the one case**: the grader now probes
a patch naming another real user's id, a bogus private id (deterministic, seeded, so a candidate
cannot special-case a literal), a matching id, and a repeated bogus id. Permanent regression
coverage added: two structurally distinct attack variants (FAIL) and two structurally distinct
correct implementations, including the existing write-through architecture (PASS). Full audit
regression corpus: 85/85 → **89/89** correct.

## Gap 2 — Band 3 decisionPoints still walked from the entrypoint

`notification-settings-regression` measured `CONTEXT_TEST_STRONG` in the Audit #2 repair above for
the wrong reason: `investigationDepth` had already been made search-aware, but `decisionPoints` still
walked the entrypoint-rooted import path, crediting forks a reader who follows the prompt's own
precise search term (`settingValue(key, overrides)`, verbatim in the prompt) would never encounter.
`evaluation/lib/orientation.mjs` now derives one search-aware landing point -- the file a precise,
realistic search actually reaches, falling back to any symptom-bearing file and finally to the
entrypoint only when no useful vocabulary exists -- and measures `investigationDepth`,
`decisionPoints` and the reported path from that same point. No threshold changed.

**Measured result changes from 3 STRONG / 2 WEAK to 2 STRONG / 3 WEAK.** A redesign that would
manufacture STRONG for `notification-settings-regression` by adding a genuine competing subsystem
was considered and rejected for this small, scoped repair: doing it honestly means adding real
reachable, symptom-plausible files and re-verifying the task's whole grader/overlay set, which is
materially larger than a measurement fix. It is reported honestly weak instead. `task-update-
duplication` and `completion-state-regression` remain weak, as before. A scoped diversity review
found three of the five Band 3 tasks (`notification-settings-regression`, `task-update-duplication`,
`completion-state-regression`) share both a short, largely forkless investigation shape and a
"comment states the correct rule, code silently does the opposite" bug-injection style; changing
either without touching investigation topology (and risking an unintended STRONG/WEAK flip, or
without re-verifying an interlinked fixture/grader/overlay set) was judged to exceed this repair's
scope and was not attempted. The measured result is reported as measured, not forced toward a
desired number.

## Gap 3 — regression evidence did not distinguish smoke from full coverage

Audit #3 empirically reproduced, through the real production `CuratorIndependentVerifier` on two
live fixtures, that a candidate can pass `hiddenGrader`, pass the regression check, and still
silently break an unrelated exported function the check never exercises -- and still reach DVS.
`protocol.json` already disclosed this as a smoke check in prose, but `regression: "PASS"` read no
differently than a full behavioral suite's verdict would. `regression` evidence now carries explicit
`scope: "SMOKE"`, `method: "MODULE_LOAD_AND_ENTRYPOINT"`, `coverage: "PARTIAL"` metadata (
`RegressionEvidenceScope`, `src/evaluation/independent-verification.ts`) alongside its PASS/FAIL
verdict, attached whenever a regression check actually ran and absent (not "full") when nothing did.
`evaluation/protocol.json`'s `verification.regression` is now a structured object carrying the same
fields plus the Audit #3 finding, rather than a single prose string. Nothing about `isDvs`,
`evidenceForStatus`, `evaluationRunIncoherences` or the independent-verification boundary changed --
this is additive evidence labeling, not a semantic change. A cheap, generic, reference-free
strengthening (comparing pristine-vs-candidate export shape) was evaluated and rejected: it would
not have caught this finding (the broken functions stayed exported, just wrong), and a value-level
generic check is not achievable without either a reference solution or per-task probes -- a
benchmark rewrite, not a small repair.

## Final measured validation (pre-freeze small repairs)

| Gate | Result |
| --- | --- |
| Audit regression corpus (9 corpora, incl. 2 new) | 89/89 correct |
| False-pass corpus (`wrong`,`attack`, all phases) | 58/58 correctly FAIL |
| False-fail corpus (`reference`,`alternative`,`probe`, all phases) | 83/83 correctly PASS |
| Full curator matrix (default) | 116/116, 0 failures |
| Band 3 curator matrix (`--band band3`, all candidate types) | 25/25, 0 failures |
| Band 3 orientation audit | 2 STRONG, 3 WEAK, 0 `NOT_A_CONTEXT_TEST` — measured, not declared |
| Cross-suite audit | 0 failures; band3 counts match (2/3/0); fixture distinctness unaffected |
| Production trust boundary + protocol/DVS unit tests | 17 + 29 = 46/46 PASS |
| ABI / negative tests | 45/45 PASS |
| `npm test` | 1,146 passed, 8 skipped -- unchanged from before this repair |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, exit code 0 |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| `npm run smoke` | PASS |
| `npm run compose:check` | `ENVIRONMENT_UNAVAILABLE` -- Docker not installed here, not fabricated |
| `npm run validate` | `INCOMPLETE_ENVIRONMENT` -- stops at `compose:check` for the reason above |

No 1-hour determinism stress rerun was needed for this repair: none of the three gaps touch
determinism, workspace isolation, or scheduling, and the Audit #2 repair's recorded 2,030-execution
result was independently spot-checked at reduced scale (435 executions, 0 failures) during Audit #3
rather than rerun in full again here.

## Pre-freeze small-repair checkpoints

| Commit | Checkpoint |
| --- | --- |
| `062f2c2` | Close stale cache invalidation grader gap |
| `0cb60cf` | Make band3 orientation measurement search-aware |
| `c3ac66c` | Format fix-up (biome) for the above |
| `a1981f5` | Clarify smoke regression evidence scope |
| `b41bd06` | Format fix-up (biome) for the regenerated band3 report |
| *next* | This documentation record |

No Native or MAF frontier participant, paid benchmark model, or performance comparison was run as
part of this repair. This was a **mixed-auditor continuation**: the third audit's own continuity was
not independently verifiable, and this repair -- like the one before it -- was carried out by
Claude, the same model family that authored the repair it is auditing. One short, fresh,
non-Claude verification pass before an irreversible suite freeze remains recommended for that
reason, independent of anything measured above.

`FRONTIER_MODELS_EXECUTED: NO`
