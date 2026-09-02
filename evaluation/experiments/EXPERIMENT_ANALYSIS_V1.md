# MAF Native-vs-MAF Experiment Analysis Specification v1

Status: frozen by git tag `maf-experiment-analysis-v1` before any scoring run.

This document is a **pre-scoring analysis specification**. It does not rewrite
Protocol v1 or Protocol v2. It freezes the three statistical decisions that the
independent scoring-readiness audit proved Protocol v1/v2 left materially
underspecified, so that two independent implementations of the eventual
final analysis must agree.

Machine-readable companion: [`experiment-analysis-v1.json`](experiment-analysis-v1.json).
Reference implementation: [`analysis/analysis-v1.ts`](analysis/analysis-v1.ts).
Independent numerical checker: [`analysis/newcombe-method10-independent.py`](analysis/newcombe-method10-independent.py).

---

## 0. Freeze identities

| Artifact | Tag | Peeled SHA |
|---|---|---|
| Suite | `maf-suite-freeze-v1` | `92f13ae67802dd0049ca001f70839a9451120900` |
| Protocol v1 | `maf-experiment-protocol-v1` | `b183b20a08b1d4f6902bffea49fe139f80cad4e9` |
| Protocol v2 | `maf-experiment-protocol-v2` | `b086b21e1e66f4a3c039d5c60079d9311eb82e15` |
| Analysis v1 | `maf-experiment-analysis-v1` | the peeled commit of this tag |

`createdBeforeScoring = true`. This specification was written and tagged with:

- `FROZEN_SCORING_TASKS_EXECUTED = 0`
- `SCORING_RESULTS_PRESENT = 0`
- runner tag `maf-scoring-runner-v1` absent
- no campaign observation store in the repository
- the synthetic `preflight-task` / dry-run reports tagged `NON_SCORING` / `NOT_PART_OF_EXPERIMENT` and not counted

No frontier scoring result was inspected or generated in order to write this document.

The scoring runner is **not** frozen by this tag. Eventual billed scoring must later require
suite tag + protocol tag + analysis tag + runner tag, and every scoring / final-analysis
provenance record must persist `analysisTag`, `analysisSha`, and `analysisVersion`.

---

## 1. Why this artifact exists, and why it is not Protocol v3

Protocol v1 section 15 (inherited unchanged by Protocol v2) pre-registered:

- primary metric `DVS_RATE_AMONG_VALID_RUNS`
- task-level majority-of-3 aggregation
- paired McNemar analysis
- a Wilson 95% CI on the aggregate DVS-rate difference

The scoring-readiness audit, implemented in
`evaluation/experiments/scoring/lib/statistics.ts` as `KNOWN_STATISTICAL_AMBIGUITIES`,
proved three details were not determined by that text:

1. majority aggregation when only 1 or 2 of 3 repetitions remain valid
2. the exact McNemar variant (already almost determined; this spec names it completely)
3. the exact Wilson/score method for a **difference of paired proportions**, especially under
   asymmetric invalidation

**This is a clarification, not a new experimental-analysis protocol**, because:

- Treatment semantics, N=3, 29 tasks, 174 runs, invalid-run policy, stopping rule, and the
  primary metric name/definition are untouched.
- McNemar is the test Protocol 15.3 already named: "report the exact binomial p-value on the
  discordant pairs."
- The phrase "Wilson score 95% confidence interval on the aggregate DVS-rate difference",
  occurring in the same paragraph that **rejects** an unpaired two-proportion test, is the
  published Wilson-derived interval for a paired difference of proportions: Newcombe (1998)
  *Statistics in Medicine* 17:2635–2650, Method 10. That method is constructed from Wilson
  score intervals on the two paired marginals. The independent-samples Newcombe square-and-add
  interval (Newcombe 1998 *Stat Med* 17:873–890 Method 10) is excluded because it contradicts
  the pairing mandate in the same sentence. Tango's score interval is a different method and
  is not a Wilson interval.

If the frozen wording had been only "a 95% CI on the difference" with no Wilson and no pairing
constraint, naming Method 10 would have been a new inferential choice and would have required
Protocol v3. That is not this case.

Protocol v1/v2 text is not edited.

---

## 2. Primary run-level metric (unchanged)

**`DVS_RATE_AMONG_VALID_RUNS`** remains the primary metric, computed **per arm at run level**
exactly as Protocol section 7:

```
rate_arm = (DVS successes among VALID runs for that arm) / (VALID runs for that arm)
```

Always report, per arm:

| Field | Meaning |
|---|---|
| `validRuns` | denominator |
| `invalidRuns` | infrastructure-invalid count, reported separately |
| `dvsCount` | numerator (VALID ∧ DVS only) |
| `rate` | `dvsCount / validRuns`, or `N/A` if `validRuns = 0` |

Arm denominators **may differ**. They are not resolved by imputation, by counting invalid as
failure, or by dropping otherwise-valid runs to equalize raw denominators.

A single-proportion Wilson 95% interval on each arm's own run-level rate is unambiguous and is
reported descriptively. It is **not** the interval on the difference.

The task-level paired inferential layer below does not silently replace this primary metric.

---

## 3. Task-arm cell aggregation

Pairing unit for inference is the **task**. Before pairing, each task × arm cell of 3 planned
repetitions is collapsed to one cell outcome.

Let `V` be the VALID observations in the cell. Infrastructure-invalid observations are
excluded from `V`. Their `dvs` field is ignored even if a pipeline has set it. Invalid runs
are never silently converted into `DVS=false`. There is no imputation.

| Valid observations | Rule | Cell status | Binary outcome |
|---|---|---|---|
| 3 | ordinary majority: ≥2 of 3 DVS → true, else false | `DETERMINATE` | boolean |
| 2, both DVS | identifiable majority of the valid subset | `DETERMINATE` | `true` |
| 2, both non-DVS | identifiable majority of the valid subset | `DETERMINATE` | `false` |
| 2, split 1 DVS / 1 non-DVS | no majority; no tie-break | `UNRESOLVED` | none |
| 1 | a single remaining valid run is not a majority-of-3 | `UNRESOLVED` | none |
| 0, with ≥1 recorded observation | all recorded repetitions infrastructure-invalid | `INVALID_CELL` | none |
| 0, with 0 recorded observations | slot has not run | `UNOBSERVED` | none |

`reducedN` is true iff at least one observation exists, the cell is not `INVALID_CELL`, and
`|V| ≠ 3`. Reduced-N cells are disclosed (Protocol 17.2), never hidden.

This preserves the frozen majority-of-3 intent: a true cell still requires two DVS successes,
and a false cell requires two agreeing valid non-DVS outcomes. It refuses to treat
infrastructure loss as arm failure, which would contradict Protocol section 17.

---

## 4. Paired-task eligibility

A task enters the **paired inferential denominator** if and only if **both** of:

- the Native task-arm cell is `DETERMINATE`
- the MAF task-arm cell is `DETERMINATE`

Every other task is excluded from McNemar and from the paired difference CI. Excluded tasks
are reported with counts and reasons (`UNRESOLVED_*`, `INVALID_*`, `UNOBSERVED_*`,
`MIXED_INELIGIBLE`). They are not imputed.

Protocol 15.2's per-arm task-level rates ("task-level DVS successes / task-level valid cells")
remain a **descriptive** layer and may have unequal denominators. They are reported. They are
not the input to the paired test or the paired CI.

When every task is determinate on both arms, the descriptive task-level difference and the
paired-complete-case difference coincide.

---

## 5. McNemar

- **Pairing unit:** task.
- **Input:** determinate Native/MAF binary cell outcomes after section 3, restricted to the
  eligible set of section 4.
- **2×2 labelling:**

  |  | MAF DVS | MAF non-DVS |
  |---|---|---|
  | Native DVS | `n11` | `n10` |
  | Native non-DVS | `n01` | `n00` |

- **Test:** two-sided **exact** McNemar, i.e. two-sided exact binomial on the discordant
  counts `(n10, n01)` under `p = 0.5`. Equivalently, `P = min(1, 2 F(min(n10,n01); n10+n01, 0.5))`
  where `F` is the `Bin(n10+n01, 0.5)` cdf. Because the null is `p = 0.5`, the doubling
  convention and the minimum-likelihood convention coincide.
- **Do not** switch to McNemar χ², Yates, or any asymptotic form based on observed counts.
- **Persist:** `n00`, `n01`, `n10`, `n11`, `discordantPairs = n10+n01`, exact `pValue`.
- **Zero discordance** (`n10 = n01 = 0`, eligible `n ≥ 0`): `pValue = 1` by construction.
  This is the mathematically appropriate deterministic result. It is **not** evidence of
  equivalence; the paired test simply has no discordant information. Document that sentence
  on every such report.

---

## 6. Paired difference confidence interval

### 6.1 Method

**Newcombe (1998) Statistics in Medicine 17:2635–2650, Method 10.**

Wilson score intervals on the two paired marginal proportions, combined with a
continuity-corrected phi coefficient estimated from the same 2×2 table. This is the
computationally closed-form Wilson-derived interval Newcombe recommended for paired
proportion differences.

- Confidence level: `1 − α = 0.95`.
- `z = Φ⁻¹(1 − α/2) = 1.959963984540054` (the same quantile already used for the
  single-proportion Wilson). Published Table III of Newcombe 1998 was computed with
  `z = 1.96`; tests match that table at `z = 1.96` to 4 decimal places. Production uses
  the more precise quantile above.
- Difference direction: **MAF − Native**, matching Protocol 15.2.

### 6.2 Inputs

From the eligible paired-task 2×2 of section 5:

```
n = n11 + n10 + n01 + n00
e = n11          (both DVS)
f = n01          (MAF only)
g = n10          (Native only)
h = n00          (both non-DVS)
p_MAF    = (e + f) / n
p_Native = (e + g) / n
θ̂        = (f − g) / n = p_MAF − p_Native
```

If `n = 0` (no eligible paired tasks): the interval is `INAPPLICABLE`. Do not invent
`[−1, 1]` or `[0, 0]`.

### 6.3 Single-proportion Wilson (inner intervals)

For a binomial count `s` in `n` observations, the Wilson score interval `(ℓ, u)` is the
closed form of the roots of `|m − s/n| = z √(m(1−m)/n)`:

```
center = (p̂ + z²/(2n)) / (1 + z²/n)
half   = [z / (1 + z²/n)] · √( p̂(1−p̂)/n + z²/(4n²) )
ℓ = max(0, center − half)
u = min(1, center + half)
```

Compute `(ℓ_MAF, u_MAF)` from `s = e+f` and `(ℓ_Native, u_Native)` from `s = e+g`.

### 6.4 Continuity-corrected phi (Method 10)

```
A = (e+f)(g+h)(e+g)(f+h)
φ_raw_numerator = eh − fg
```

- If `A = 0` (any 2×2 margin is zero): `φ_used = 0`.
- Else if `eh − fg > 0`: `φ_used = max(eh − fg − n/2, 0) / √A`  (continuity correction).
- Else: `φ_used = (eh − fg) / √A`  (no correction when the uncorrected numerator is ≤ 0).

Persist both `phiRaw` (uncorrected, or 0 when `A = 0`) and `phiUsed`.

### 6.5 Interval

```
dℓ_MAF     = p_MAF − ℓ_MAF
du_Native  = u_Native − p_Native
dℓ_Native  = p_Native − ℓ_Native
du_MAF     = u_MAF − p_MAF

rad_lower = dℓ_MAF²    − 2 φ_used dℓ_MAF    du_Native + du_Native²
rad_upper = dℓ_Native² − 2 φ_used dℓ_Native du_MAF    + du_MAF²

lower = max(−1, θ̂ − √max(0, rad_lower))
upper = min( 1, θ̂ + √max(0, rad_upper))
```

Clamp radicands at 0 to absorb floating-point noise. Clamp the interval to `[−1, 1]`;
Newcombe proves Method 10 stays inside that range analytically, so the clamp is a
numerical guard, not a change of method.

### 6.6 Zero discordance

When `n10 = n01 = 0` and `n > 0`, `θ̂ = 0` and Method 10 still returns a **non-degenerate**
interval (this is why Newcombe preferred Method 10 over Method 8, which can tether at 0).
Report that interval. Combined with McNemar `p = 1`, the correct reading is: the paired
test has no discordant information; the CI width is the remaining uncertainty about a
common success rate, not a proof of equivalence.

### 6.7 Rounding

Persist IEEE-754 binary64 values. Human reports print rates and CI endpoints to 6 decimal
places and p-values to 6 decimal places (or scientific notation if `< 1e-6`). Do not round
before comparing to 0 or before storing provenance.

### 6.8 Independent numerical checks

1. Newcombe 1998 Table III, Method 10, `z = 1.96`: every published 4-decimal endpoint is
   reproduced to within `1e-4` (one unit in the last published place).
2. Closed-form Wilson vs the quadratic `|m − p̂| = z √(m(1−m)/n)` construction: agreement
   to `1e-12`.
3. Independent Python calculator `analysis/newcombe-method10-independent.py` vs this
   TypeScript reference at `z = 1.959963984540054`: agreement to `1e-10` on the frozen
   synthetic fixtures listed in `tests/experiment-analysis-v1.test.ts`.

---

## 7. Unequal denominators

| Layer | Denominator | Equal across arms? |
|---|---|---|
| Primary run-level `DVS_RATE_AMONG_VALID_RUNS` | VALID runs per arm | not necessarily |
| Descriptive task-level rates (Protocol 15.2) | determinate cells per arm | not necessarily |
| Paired McNemar + Method 10 CI | eligible paired tasks | yes, by construction |

Do not impute, do not count invalid as failure, and do not drop otherwise-valid individual
runs merely to equalize raw denominators.

---

## 8. Secondary metrics

Every secondary and diagnostic metric already frozen by Protocol v1/v2 is **unchanged**.
This specification does not resolve, promote, or redefine any of them.

One related presentation difference is inherited, not newly resolved: Protocol section 9
defines `COST_PER_DVS` at run level (invalid runs stay in the cost numerator), while
section 15.2 also asks for a cost/DVS difference on task-level aggregates. Both
presentations remain available; neither is altered here. No other material secondary
ambiguity was found that would change a pre-registered secondary statistic independently
of the three audited gaps.

---

## 9. Invalid-run policy (unchanged)

Unmodified from Protocol section 17 / `evaluation/protocol.json`:

- invalid runs never count toward DVS
- invalid runs are reported separately from the valid-run denominator
- they are never silently dropped
- they are never converted into DVS failures in order to complete a majority

---

## 10. Finalization rule

A report may be labelled `FINAL` only when all of:

1. every scheduled scoring slot has a terminal observation (`completedSlots = expectedSlots`)
2. the caller explicitly sets `allowFinal = true`
3. no task-arm cell remains `UNOBSERVED`

Otherwise the report is `PROVISIONAL` and `stoppingDecisionUse = NOT_FOR_STOPPING_DECISIONS`
(Protocol section 18: fixed N, no early stopping on trend).

---

## 11. Provenance the runner must later persist

Not required to execute this freeze. Required before any paid scoring call that will use
this analysis:

```
analysisTag = maf-experiment-analysis-v1
analysisSha = peeled commit of that tag
analysisVersion = 1.0.0
```

together with the already-frozen suite tag/SHA, protocol tag/SHA, and (once it exists)
runner tag/SHA.

---

## 12. What this specification deliberately does not do

- No provider/model benchmark calls.
- No frozen scoring tasks.
- No edit to Protocol v1, Protocol v2, the frozen suite, randomization, arms, N, timeout,
  budget, or treatment semantics.
- No freeze of `maf-scoring-runner-v1`.
- No inspection or generation of frontier scoring results.
