# MAF Scoring Runner v2 — Structural Provider Isolation

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_AUDIT_AND_FREEZE`
**Expected freeze tag:** `maf-scoring-runner-v2` (deliberately **not** created by this change)
**Supersedes:** `maf-scoring-runner-v1` @ `5484808a764c6c579ee94c269fb20c07383ddbdd` — `FROZEN_DEPRECATED_DO_NOT_SCORE`
**Caused by:** [`maf-scoring-incident-2026-09-03-v1`](../incidents/SCORING_INCIDENT_2026-09-03.md) @ `895797e0c58099c763e206b851ba144d287394db`

Runner v2 changes **no experimental semantics**. Suite v1, Protocol v2 and Analysis v1 are untouched;
the schedule, N, arms, statistics, budgets and provenance schema are identical to Runner v1. The
entire change is the safety architecture around which *provider* a scoring run is allowed to reach.

---

## 1. What actually went wrong

Runner v1's billed path was gated by fifteen checks, and on 2026-09-03 **every one of them passed
correctly**. There was no missing gate and no bug in any gate.

The failure was in a test:

```ts
// tests/scoring-freeze-simulation.test.ts, Runner v1
describe("REAL development state: no runner tag means no execution", () => {
  it("refuses on the real repository with only RUNNER gates failing", async () => {
    await runCli(["init", "--campaign", campaign, "--ceiling-usd", "100"]);
    const result = await runCli([
      "execute", "--campaign", campaign, "--confirm-billed-scoring", "--tasks", "1",
    ]);                                   // ^ no fixture, no fake executable, real repository
    expect(result.stdout).toMatch(/\[FAIL\] RUNNER_FROZEN/u);
  });
});
```

That case was safe for exactly one reason: `maf-scoring-runner-v1` did not exist, so `RUNNER_FROZEN`
failed. **The freeze ceremony is the event that makes that reason false.** When the tag was created
and pushed at HEAD, the gate passed for real, and because the invocation supplied no fixture and no
fake executable, `pinClaudeExecutable` resolved the operator's genuine
`C:\Users\Admin\.local\bin\claude.exe` through a PATH lookup and billed three pairs — six arm-runs of
`idempotency-key-race` — against a first-party subscription.

The root cause, stated precisely:

> **Test safety depended on external repository state instead of structural provider isolation, and
> the absence of test configuration fell back to the real provider.**

Both halves matter. The first is why the safety property evaporated. The second is why the failure
was expensive rather than merely noisy.

---

## 2. The Runner v2 rule

A scoring spawn must **name which provider it is**, in a value that cannot be forged:

| Identity | Meaning |
|---|---|
| `REAL_PROVIDER_EXECUTION` | The operator's real first-party Claude Code CLI |
| `TEST_DOUBLE_PROVIDER_EXECUTION` | An approved fake executable from a test-controlled fixture |

There is no third state and, decisively, **no default**. Supplying nothing yields a refusal, not the
real provider. The incident's failure direction is inverted: the unconfigured path is now the safe
one.

`ProviderIdentity` (`lib/provider-identity.ts`) is branded with a module-private symbol, so no object
literal and no type assertion anywhere else in the repository can produce one. The only two sources
are constructors that impose requirements no caller can wish away.

### `approveTestDoubleProvider` — every condition must hold

- a path was supplied at all (absence is a refusal, never a fallback to `claude`)
- the path is **absolute** (a bare name would be resolved through PATH at spawn time)
- it names a real, readable file
- it is not named like the real Claude CLI (`claude`, `claude.exe`, `claude.cmd`, …)
- **its own bytes contain `MAF_SCORING_TEST_DOUBLE_PROVIDER_V2`**
- an ancestor directory carries `.maf-test-double-provider`, declaring a test-controlled root

The marker is content-based on purpose. A real Claude binary can be copied, renamed or dropped into
any directory a test likes — but it cannot come to contain that string. Executable identity is
*established*, not inferred from a path or a naming convention. The root marker answers the
complementary question: not *what* the file is, but *where it is allowed to come from*. Either check
alone is weaker than it looks.

### `resolveRealProviderIdentity` — refuses outright in a test context

This is the interlock. Real-provider identity is not something a test can obtain by having every
other gate pass — which, in the incident, is exactly what happened.

---

## 3. Why this is not an environment opt-in

Mission Repair 7 forbids resting the repair on something like `MAF_ALLOW_REAL_SCORING_TESTS`.

Test-context detection (`detectExecutionContext`) is **one input** to the interlock, never the
mechanism:

- It is **fail-safe**: any single signal (`VITEST`, `VITEST_WORKER_ID`, `VITEST_POOL_ID`,
  `JEST_WORKER_ID`, `NODE_TEST_CONTEXT`, `NODE_ENV=test`, an npm test lifecycle, or an explicit
  declaration) forces `TEST`, and `TEST` admits only a test double.
- It is **inherited, not opted into**: a vitest worker exports those variables, and a child process
  spawned with `{...process.env}` — precisely how the incident reached the CLI — carries them.
  Nothing has to be remembered.
- `MAF_SCORING_EXECUTION_CONTEXT` can only force `TEST` (the safe direction). No environment value
  can force `PRODUCTION` or relax the interlock.

And if every environment signal were somehow stripped, a test would still have to hand the spawn
boundary a forged `ProviderIdentity` to reach a real provider — and it cannot construct one.

---

## 4. Where the enforcement lives

| Layer | Enforcement |
|---|---|
| `run-scoring.ts` `execute`/`init` | `requireProviderIsolation()` runs **first** — before the campaign is opened, before git is read, before `pinClaudeExecutable` can resolve or probe anything. TEST without a complete `--test-fixture` stops the command dead with zero processes spawned. |
| `execution-gate.ts` | Three new checks whose truth depends on **no external state**: `PROVIDER_IDENTITY`, `TEST_CONTEXT_ISOLATION`, `RUNNER_V1_NOT_SELECTED`. |
| `issueProviderAuthorization` | The capability binds a `ProviderIdentity`, not a path string. Runner v1 bound a path, which says *where* a binary is but nothing about *what* it is — so a test holding the real executable's path held a perfectly valid capability. |
| `assertAuthorizedForPair` | Calls `assertProviderIdentityForSpawn` before any pair binding is even considered. |
| `participant-runner.ts` step 4 | Re-asserts at the **last statement before a child process can exist**, re-detecting the context rather than trusting the one the capability was minted in. |

### Test seams: same power, opposite failure direction

Runner v1 had one seam, `--git-fixture`, whose module supplied simulated git state *and* the fake
executable *and* the auth probe *and* the participant fixture root. Convenient — and the reason a
test that passed nothing got the real version of all four.

Runner v2 replaces it with `--test-fixture`, which must supply **every** field it stands in for
(`git`, `testDoubleProviderPath`, `resolve`, `checkAuth`, `participantFixtureRoot`). A module
providing four of five is refused, not silently completed with the real fifth. Under a `PRODUCTION`
context, supplying a test fixture at all is refused.

Simulating a frozen tag world therefore grants no power over which binary runs, and vice versa.

---

## 5. Runner v1 is never selected again

- `RUNNER_TAG` is now `maf-scoring-runner-v2`; `RUNNER_VERSION` is `2.0.0`.
- `RUNNER_V1_NOT_SELECTED` refuses if the executing revision is `5484808…`, or if the configured
  runner tag is ever `maf-scoring-runner-v1`.
- The v1 tag is **not deleted or moved**. It is the immutable record of what was executing during the
  incident, and it stays exactly where it is.

Because `maf-scoring-runner-v2` does not exist yet, `RUNNER_FROZEN` cannot pass, so real paid
execution remains structurally impossible until an independent audit creates and pushes it. Billed
execution will then require, together: suite freeze, Protocol v2 freeze, Analysis v1 freeze, incident
freeze, Runner v2 freeze, and `HEAD` equal to the local **and** remote peeled Runner v2 SHA.

---

## 6. The incident's observations enter nothing

The six accidental arm-runs are `NON_OFFICIAL INCIDENT OBSERVATIONS`. They have no path into campaign
state, the DVS denominator, task aggregation, McNemar, the Newcombe interval, cost-per-DVS, or any
official report. This is enforced structurally rather than by policy: **no scoring source file reads
the incident artifact at all**, and a test asserts that over every file in `lib/` and `run-scoring.ts`.

`INCIDENT_TAG` / `INCIDENT_SHA` in `lib/frozen-refs.ts` *name* the incident; they never supply data.
Nothing deleted is reconstructed.

`idempotency-key-race` remains an entirely ordinary member of Suite v1 — same frozen schedule
position, `N=3` per arm, not moved, not deferred, not pre-filled, not marked invalid. A test asserts
this directly.

---

## 7. Proof

`tests/scoring-runner-v2-isolation.test.ts` reproduces the incident's structural conditions and the
mission's full matrix:

| Condition | Result |
|---|---|
| fake Git + approved fake executable | simulation runs, `TEST_DOUBLE` spawned |
| fake Git + no fake executable | **refuse**, 0 spawns |
| fake Git + bare `claude` | **refuse**, 0 spawns |
| fake Git + real Claude path | **refuse**, 0 spawns |
| fake Git + unmarked executable | **refuse**, 0 spawns |
| fake Git + marked executable outside any declared root | **refuse**, 0 spawns |
| real Git + `--confirm-billed-scoring` under test | **refuse before anything resolves**, 0 spawns |
| real Git + no billed confirmation | `validate` only, no gate evaluated |
| Runner v1 tag present (really is, on this machine) | no effect on test safety |
| simulated Runner v2 tag present | fake simulation possible |
| future/unrelated runner tags present | no effect whatsoever |
| capability claims TEST but executable is REAL | **refuse** at the boundary |
| provider boundary invoked directly without a test double | **refuse** |

The incident regression asserts the mission's proof obligation directly:

```
REAL_RUNNER_TAG_PRESENT           = true   (the real repo genuinely holds maf-scoring-runner-v1)
TEST_BILLED_CONFIRMATION_PRESENT  = true
ALL_FREEZE_GATES_SIMULATED_VALID  = true
NO_APPROVED_TEST_PROVIDER         = true
REAL_PROVIDER_SPAWNS              = 0
```

then, with an approved fake provider and fake git state:

```
APPROVED_FAKE_PROVIDER            = true
FAKE_PROVIDER_SPAWNS              > 0
REAL_PROVIDER_SPAWNS              = 0
```

Two further structural rules are enforced over the test suite's own source: every
`--confirm-billed-scoring` in `tests/` is accompanied by `--test-fixture`, and no test references the
removed conflated seam.

---

## 8. What was deliberately **not** changed

Every existing safety property is preserved unchanged: the `$16` pair campaign exposure, the `$8`
per-run hard budget, the shared retry budget and deadline, local+remote peeled tag verification,
absolute executable pinning, first-party auth enforcement, effective user/workspace config
validation, capability-executable binding, campaign runner identity, double-launch protection,
crash fail-closed behaviour, atomic persistence, invalid-rerun preservation, the Analysis v1 binding,
and `NON_SCORING` exclusion.

No experimental parameter, statistical method, stopping rule, schedule, model, effort, budget or
timeout was changed — and none was changed on the basis of the incident's observed outcome.
