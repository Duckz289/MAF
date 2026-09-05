# MAF Scoring Runner v2 — Structural Provider Isolation

**Status:** `REPAIRED_PENDING_INDEPENDENT_RE_AUDIT_AND_FREEZE`
**Audit verdict repaired:** `SCORING_RUNNER_V2_REPAIR_REQUIRED` (see §3a)
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

`ProviderIdentity` (`lib/provider-identity.ts`) is authenticated at **runtime** by a module-private
`WeakSet`, so no object literal, spread, `Object.assign` clone or JSON round-trip can produce one.
The only two sources are constructors that impose requirements no caller can wish away. (A
compile-time brand is also present, but it is not the mechanism — see §3a.)

### `approveTestDoubleProvider` — every condition must hold

- the execution context is **runtime-authentic** and is `TEST`
- a path was supplied at all (absence is a refusal, never a fallback to `claude`)
- the path is **absolute** (a bare name would be resolved through PATH at spawn time)
- the path **resolves through `realpath`** to a real, readable file
- neither the supplied **nor the resolved** basename names the real Claude CLI (`claude`,
  `claude.exe`, `claude.cmd`, …)
- **the resolved file's own bytes contain `MAF_SCORING_TEST_DOUBLE_PROVIDER_V2`**
- an ancestor of the **resolved** file carries `.maf-test-double-provider`, declaring a
  test-controlled root
- the resolved file is **contained within the resolved root**, compared case-normalised

The marker is content-based on purpose. A real Claude binary can be copied, renamed or dropped into
any directory a test likes — but it cannot come to contain that string. Executable identity is
*established*, not inferred from a path or a naming convention. The root marker answers the
complementary question: not *what* the file is, but *where it is allowed to come from*. Either check
alone is weaker than it looks.

### `resolveRealProviderIdentity` — refuses outright in a test context

This is the interlock. Real-provider identity is not something a test can obtain by having every
other gate pass — which, in the incident, is exactly what happened.

---

## 3. Execution context is constructed, never sniffed

The independent audit found that deriving `TEST` vs `PRODUCTION` from ambient environment variables
made a mutable, inherited signal set the **trust root**, and that a sanitized environment silently
reclassified a test as `PRODUCTION`. Both are now fixed.

`lib/execution-context.ts` makes the classification an explicitly constructed, runtime-authentic
value:

| Context | Who can construct it |
|---|---|
| `PRODUCTION` | `createProductionExecutionContext()`, called by `run-scoring.ts` and nothing else |
| `TEST` | the internal seam `lib/internal/test-support.ts`, which **no production source imports** |

There is deliberately **no `--test-mode` flag**, and no environment variable that constructs a
context. A test supplies its context through `--test-fixture`, whose module must export a context
this process actually minted; a fabricated `{ kind: "TEST" }` is refused, not believed.

Ambient environment is still **observed, recorded and printed** — it is simply wired in one
direction only:

> A context claiming `PRODUCTION` while the environment plainly shows a test harness is a
> **contradiction**, and fails closed. No environment value can grant, relax or upgrade anything.

That asymmetry is what keeps the incident regression while removing ambient trust. A test driving the
production command with no seam claims `PRODUCTION`, contradicts its own environment, and is refused
before `pinClaudeExecutable` can resolve or probe anything. Meanwhile an explicit `TEST` context with
**every** harness variable stripped stays `TEST` — asserted directly by
`MATRIX: a sanitized environment cannot promote a TEST run`.

Separately, the structural test `STRUCTURAL: the test-support seam is unreachable from production
sources` scans the production tree and fails if any file imports `lib/internal/`, so "the production
CLI cannot construct a TEST context" is a checked property rather than a convention.

---

## 3a. What the independent audit changed

The audit's verdict was `SCORING_RUNNER_V2_REPAIR_REQUIRED`, on five findings. Each rested on the
same mistake: a **compile-time** construct standing in for a **runtime** guarantee.

| # | Finding | Repair |
|---|---|---|
| 1 | `ProviderIdentity` was only TypeScript-branded, so a cast object literal passed the lowest boundary | module-private `WeakSet` registration; literal, spread, `Object.assign` clone, JSON round-trip and field-by-field rebuild all refused |
| 2 | `ProviderAuthorization` used the same compile-time-only pattern, and could be minted from a hand-written `{ authorized: true }` decision | `ExecutionGateDecision` **and** `ProviderAuthorization` are both runtime-authentic; the capability additionally binds the execution context, the frozen-authority digest and the budget-state digest |
| 3 | `TEST` vs `PRODUCTION` trust depended on mutable ambient environment | explicit constructed contexts (§3); ambient can only refuse |
| 4 | the incident tag was not a mandatory paid-execution freeze authority | `INCIDENT_FROZEN` gate: local **and** remote peeled SHA, `--skip-remote` reported as not proven; campaigns bind `incidentTag`/`incidentSha` and re-verify on resume |
| 5 | test-double root containment was lexical, escapable by symlink/junction alias | containment decided on `realpath`-resolved, case-normalised paths; marker bytes read from the **resolved** file |

The compile-time brands are retained on both types, but only to stop accidental structural typing.
They are explicitly **not** the security mechanism: `tsc` erases them, and the audit's finding was
precisely that nothing then remained.

---

## 4. Where the enforcement lives

| Layer | Enforcement |
|---|---|
| `run-scoring.ts` `execute`/`init` | `requireProviderIsolation()` runs **first** — before the campaign is opened, before git is read, before `pinClaudeExecutable` can resolve or probe anything. TEST without a complete `--test-fixture` stops the command dead with zero processes spawned. |
| `execution-gate.ts` | Checks whose truth depends on **no external state**: `EXECUTION_CONTEXT_AUTHENTIC`, `PROVIDER_IDENTITY`, `TEST_CONTEXT_ISOLATION`, `RUNNER_V1_NOT_SELECTED` — plus `INCIDENT_FROZEN`, which does. |
| `issueProviderAuthorization` | Requires a **runtime-authentic, authorized** gate decision, a runtime-authentic identity, and a runtime-authentic context that all three agree on. Binds campaign, schedule, both slot digests, the absolute executable, the identity object, the context object, the frozen-authority digest and the budget-state digest. Runner v1 bound a path *string*, which says *where* a binary is but nothing about *what* it is — so a test holding the real executable's path held a perfectly valid capability. |
| `assertAuthorizedForPair` | Proves the capability's own authenticity **before reading any of its fields** — the fields of a forged object say whatever its author wanted — then calls `assertProviderIdentityForSpawn` before any pair binding is considered. |
| `participant-runner.ts` step 4 | Re-asserts at the **last statement before a child process can exist**: re-proves authenticity of identity *and* context, and re-reads the live environment for a contradiction. |

### Test seams: same power, opposite failure direction

Runner v1 had one seam, `--git-fixture`, whose module supplied simulated git state *and* the fake
executable *and* the auth probe *and* the participant fixture root. Convenient — and the reason a
test that passed nothing got the real version of all four.

Runner v2 replaces it with `--test-fixture`, which must supply **every** field it stands in for
(`executionContext`, `git`, `testDoubleProviderPath`, `resolve`, `checkAuth`,
`participantFixtureRoot`). A module providing five of six is refused, not silently completed with the
real sixth. Under a `PRODUCTION` context, supplying a test fixture at all is refused.

The `executionContext` field is what makes the seam the *only* route to a `TEST` classification, and
it is checked rather than trusted: the CLI refuses `TEST_SEAM_CONTEXT_NOT_AUTHENTIC` for a
hand-written object, a spread clone, an `Object.assign` clone or a JSON round-trip. Note the
direction of the capability this grants — a `TEST` context can only ever spawn an approved double, so
the seam is strictly *less* powerful than a production run, never more.

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
execution will then require, together: suite freeze, Protocol v2 freeze, Analysis v1 freeze,
**incident freeze**, Runner v2 freeze, and `HEAD` equal to the local **and** remote peeled Runner v2
SHA.

### The incident record is a mandatory authority

Runner v2 exists *because* of `maf-scoring-incident-2026-09-03-v1`, so a paid campaign that cannot
produce the record governing its own runner is not reproducible evidence. `INCIDENT_FROZEN` proves
the tag exists locally, is published on origin, and peels on **both** sides to
`895797e0c58099c763e206b851ba144d287394db`. Every failure mode refuses: absent locally, absent
remotely, wrong local SHA, wrong remote SHA, local-only, remote-only, remote lookup failure, and
`--skip-remote` (reported as `REMOTE_NOT_CHECKED`, which is never OK).

Campaigns bind `incidentTag` and `incidentSha` at `init` and re-verify them on every `resume` and on
every paid `execute`. A development campaign created without them **cannot be promoted to PAID** — it
is refused with an instruction to initialise a new campaign rather than silently acquiring the
identity.

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
| **forged `ProviderIdentity`** — literal, spread, `Object.assign`, JSON round-trip, field-by-field rebuild | **refuse**, 0 spawns |
| **forged `ProviderAuthorization`** — literal, spread, `Object.assign`, JSON round-trip | **refuse**, 0 spawns |
| **forged `ExecutionGateDecision`** (`{ authorized: true }`) | capability is never minted |
| **forged execution context** (`{ kind: "TEST" }`, clone, JSON round-trip) at the CLI seam and at the boundary | **refuse** |
| capability replayed against a different campaign / pair / executable / identity / freeze world / budget state / context | **refuse** |
| **sanitized environment** during an explicit TEST execution | remains TEST; only the double spawns |
| incident tag absent locally / absent remotely / wrong local SHA / wrong remote SHA / `--skip-remote` | **refuse**, 0 spawns |
| correct local **and** remote peeled incident commit | that gate passes |
| **symlink** escape from a fixture root | **refuse** (`ROOT_MARKER_ABSENT`) |
| **junction** escape from a fixture root (Windows) | **refuse** (`ROOT_MARKER_ABSENT`) |
| link whose canonical target names the real Claude CLI | **refuse** (`REAL_CLAUDE_EXECUTABLE`) |
| marker in the *filename* only | **refuse** (`MARKER_ABSENT`) |
| real file genuinely inside the root, including nested | **allow** |

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

The regression is stated as the audit's five cases, each asserting a spawn count:

| Case | Conditions | Result |
|---|---|---|
| A | freeze gates valid, billed confirmed, explicit TEST context, **no** approved double | `PROVIDER_SPAWNS = 0` |
| B | same, **with** a runtime-authentic approved double | fake spawns > 0, real spawns = 0 |
| C | forged provider identity | 0 spawns |
| D | forged authorization | 0 spawns |
| E | sanitized environment | TEST remains TEST |

Further structural rules are enforced over the tree's own source: every `--confirm-billed-scoring`
in `tests/` is accompanied by `--test-fixture`; no test references the removed conflated seam; no
production source imports `lib/internal/`; `run-scoring.ts` names no internal symbol and constructs
only the production context; and the `__INTERNAL_` symbols appear in production sources only at their
declaration sites.

Real-repository tests remain restricted to `plan`, `validate`, readiness and refusal inspection —
never a billed path — and every simulated invocation runs with an isolated `HOME`/`USERPROFILE` and
no `ANTHROPIC_*` routing, so no assertion in the suite is a fact about the operator's machine.

---

## 8. What was deliberately **not** changed

Every existing safety property is preserved unchanged: the `$16` pair campaign exposure, the `$8`
per-run hard budget, the shared retry budget and deadline, local+remote peeled tag verification,
absolute executable pinning, first-party auth enforcement, effective user/workspace config
validation, capability-executable binding, campaign runner identity, double-launch protection,
crash fail-closed behaviour, atomic persistence, invalid-rerun preservation, the Analysis v1 binding,
`RunSlot` identity, the schedule digest, and `NON_SCORING` exclusion.

Production configuration validation was **not** weakened to make the suite pass. Two tests in
`tests/scoring-effective-config.test.ts` asserted that the operator's live machine was cleanly
configured; when that machine acquired active Stali/Kimi routing they failed for a reason unrelated
to the code under test — a unit test whose result is a property of the outside world, which is the
same class of defect as the incident itself. The substance (a first-party `ANTHROPIC_BASE_URL` must
be accepted, an alternate one refused) is now asserted **hermetically** against a fixture home, and
the remaining live-host checks are environment-neutral: they assert that the inspection never reads a
preserved backup, and that whenever it finds an alternate route the verdict **fails closed**.

Nothing was cleared, exported or edited to achieve this. `~/.claude/settings.json` is untouched, no
environment variable was unset, and real non-billed `scoring validate` therefore still correctly
reports `SCORING_PLAN_INVALID` on this host while that routing is active — which is the right
answer, not a problem to be fixed.

No experimental parameter, statistical method, stopping rule, schedule, model, effort, budget or
timeout was changed — and none was changed on the basis of the incident's observed outcome.
