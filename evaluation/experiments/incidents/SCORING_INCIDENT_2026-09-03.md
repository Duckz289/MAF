# MAF Scoring Incident — 2026-09-03

## 1. Incident ID

`MAF-SCORING-INCIDENT-2026-09-03-001`

## 2. Status

`CONFIRMED`
`CLOSED_FOR_CLASSIFICATION`
`REMEDIATION_PENDING_RUNNER_V2`

## 3. Timeline

Exact clock times were not preserved for this incident. Where an ordering is evidenced by git history it is stated as an ordering, not a timestamp.

- Suite freeze (`maf-suite-freeze-v1`, commit `92f13ae`) — TIME_NOT_PRESERVED
- Protocol v2 freeze (`maf-experiment-protocol-v2`, commit `b086b21`) — TIME_NOT_PRESERVED
- Analysis v1 freeze (`maf-experiment-analysis-v1`, commit `de02da4`) — TIME_NOT_PRESERVED
- Runner v1 freeze (`maf-scoring-runner-v1`, commit `5484808`) — TIME_NOT_PRESERVED
- Post-freeze validation — the test suite in `tests/scoring-freeze-simulation.test.ts` was run against the repository in its post-freeze state (runner tag now present and pointing at HEAD) — TIME_NOT_PRESERVED
- Accidental scoring execution — the `REAL development state: no runner tag means no execution` test case in that file, whose assertions assume `RUNNER_FROZEN` fails, instead found the gate passing for real, and the production `execute` path ran to completion against the first-party provider — TIME_NOT_PRESERVED
- Discovery — the mismatch between expected (`[FAIL] RUNNER_FROZEN`) and actual (real execution) test behavior was noticed — TIME_NOT_PRESERVED
- Immediate stop — no further paid execution was initiated after discovery — TIME_NOT_PRESERVED
- Independent methodology review — conducted after discovery, producing the classification recorded in this document — TIME_NOT_PRESERVED

## 4. Frozen identities

| Authority | Tag | Commit SHA |
|---|---|---|
| Suite | `maf-suite-freeze-v1` | `92f13ae67802dd0049ca001f70839a9451120900` |
| Protocol v2 | `maf-experiment-protocol-v2` | `b086b21e1e66f4a3c039d5c60079d9311eb82e15` |
| Analysis v1 | `maf-experiment-analysis-v1` | `de02da424e8d639213cf03aadfd9566ab3313adb` |
| Runner v1 | `maf-scoring-runner-v1` | `5484808a764c6c579ee94c269fb20c07383ddbdd` |

All four SHAs above were independently verified against the repository's annotated tag objects (`git rev-parse <tag>^{commit}`) as part of preparing this artifact; each peels to the commit shown.

## 5. Trigger

File: [tests/scoring-freeze-simulation.test.ts](../../../tests/scoring-freeze-simulation.test.ts)

Most cases in this file exercise `run-scoring.ts execute` against a `--git-fixture` that simulates a world where `maf-scoring-runner-v1` already exists, driving a fake CLI (`tests/fixtures/fake-claude-cli.mjs`) so no real provider is contacted.

One case, in the `REAL development state: no runner tag means no execution` block, deliberately runs the same production command **without** `--git-fixture` — against the real repository state — specifically to prove the runner-tag gate fails closed on a real (pre-freeze) machine. Its assertions are built on the tag-absence assumption:

```
expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
expect(result.stdout).toMatch(/\[FAIL\] RUNNER_FROZEN/u);
```

Before the Runner v1 tag existed, this assumption held: `RUNNER_FROZEN` failed, the run was refused, and zero participants were spawned. Once `maf-scoring-runner-v1` was created and pushed (pointing at the same commit as HEAD on this branch), the assumption silently stopped holding: `RUNNER_FROZEN` now passes for real, and — because this test case supplies no fixture and no fake executable — the production path runs against the genuine first-party Claude Code CLI instead of a simulated one.

## 6. Real execution

- Task: `idempotency-key-race` (first entry in the frozen `taskOrder` in [evaluation/experiments/randomization.json](../randomization.json), consistent with this test invoking `--tasks 1`)
- Replicates: 1, 2, 3
- Arms: Native + MAF
- Pairs: 3
- Arm-runs: 6
- Provider: first-party Claude Code
- Known executable metadata (as reported, not independently re-verified for this incident): `C:\Users\Admin\.local\bin\claude.exe`, version `2.1.251`
- Auth: `claude.ai` / `firstParty`

No credentials, tokens, or secrets are recorded in this artifact or its companion JSON file.

## 7. Observed terminal outcomes

> **INCIDENT OBSERVATION — NOT OFFICIAL SCORING DATA**

- Native: 3/3 DVS
- MAF: 3/3 DVS

These figures are the terminal output reported at the time of discovery. They are recorded here as an incident observation only, per the exclusion in Section 9 below.

## 8. Campaign durability

- The campaign directory was created with `mkdtemp` under the OS temp directory for the duration of a single test run.
- The test file's `afterEach` hook unconditionally removes that directory (`rm(campaign, { recursive: true, force: true })`) after every test, including this one.
- No durable, official campaign state, provenance record, or intent/slot history survives from this execution.
- Terminal stdout alone is not sufficient to reconstruct an official campaign record and is not treated as one.

## 9. Official status

`ACCIDENTAL_RUNS_OFFICIAL = NO`

## 10. Outcome-independent exclusion

This exclusion is **outcome-independent**. The same exclusion — Native 3/3, MAF 3/3 is not official scoring data — would apply identically had the observed terminal result instead been Native 0/3 MAF 3/3, Native 3/3 MAF 0/3, both 0/3, or any other split. The reasons for exclusion (temporary campaign, deleted state, absence of authorized official batch designation, non-reconstructable provenance) are structural, not a function of which arm looked better.

## 11. Contamination classification

`DOCUMENTED_BUT_MANAGEABLE`

`idempotency-key-race` may be officially rerun later under Runner v2. It is not disqualified from Suite v1.

## 12. Task policy

- `idempotency-key-race` remains in Suite v1.
- It must be run in its original frozen schedule position (first in `taskOrder`) when official scoring proceeds — it must not be moved, removed, or replaced.
- Accidental executions of this task must never be pooled with official runs, and must never be substituted for an official observation of this task.

## 13. Artifact validity

- Suite v1 remains valid.
- Protocol v2 remains valid.
- Analysis v1 remains valid.
- Runner v1's Git freeze (the tag and the commit it points to) remains historically valid and is not being rewritten, moved, or deleted.
- Runner v1's **operational** status is: `FROZEN_DEPRECATED_DO_NOT_SCORE`.

## 14. Required remediation

Runner v2, with structural test/provider isolation, is required before any further scoring execution (accidental or official). In particular, any test that exercises the real production `execute` path on the real repository state must not be able to silently escalate from "refuse" to "spawn a real, billed, first-party participant" purely because a tag-absence assumption it depends on stopped being true.

## 15. Explicit no-outcome-driven-change declaration

No suite element, treatment parameter, scoring parameter, statistical method, stopping rule, schedule, model, effort, budget, timeout, or analysis rule was changed based on the observed Native/MAF result.

## 16. Official scoring status

`OFFICIAL_SCORING_NOT_STARTED` — no valid official scoring observations currently exist for Suite v1 under any runner version.
