# Control API

All routes are versioned under `/api/v1`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/runs` | Create an asynchronous run; accepts optional budget/quality preferences and a bounded `performance: { command, metric, unit?, maxRegressionPercent, lowerIsBetter?, samples?, timeoutMs? }` measurement spec |
| `GET` | `/runs` | List operational summaries for all runs |
| `GET` | `/runs/:id` | Inspect one run |
| `GET` | `/runs/:id/events` | Stream SSE lifecycle events; `follow=false` returns a snapshot |
| `GET` | `/runs/:id/artifacts` | Inspect captured artifacts |
| `GET` | `/runs/:id/verifications` | Inspect trusted verification attempts and candidate lineage |
| `GET` | `/runs/:id/runtime-signals` | Inspect bounded signal-snapshot history and provenance |
| `GET` | `/runs/:id/mode-explanation` | Explain desired vs effective mode, pending enforcement, and the enforced transition timeline |
| `POST` | `/runs/:id/cancel` | Cancel a live run |
| `POST` | `/runs/:id/mode` | Record an explicit evidence-backed mode transition |
| `GET` | `/runs/:id/recovery-capsule` | Inspect the durable recovery capsule for a paused/failed run, if one was captured |
| `POST` | `/runs/:id/resume` | Explicitly resume a `PAUSED` run from its capsule; refuses on source-revision conflict |
| `POST` | `/system/emergency-stop` | Cancel all active runs and block new run creation; preserves all evidence |
| `POST` | `/system/resume-new-runs` | Lift an emergency stop |
| `GET` | `/system/status` | Whether an emergency stop is currently active |
| `GET/POST` | `/missions` | List or create mission trees |
| `POST` | `/missions/:id/split` | Split independent workstreams |
| `POST` | `/missions/:id/merge` | Merge verified branches |
| `POST` | `/missions/:id/promote` | Promote verified output |
| `POST` | `/missions/:id/collapse` | Collapse children into a solo-native parent |
| `GET` | `/auth/session` | Inspect the local user session |
| `GET` | `/auth/config` | Inspect reference-only Better Auth configuration |
| `POST` | `/connections/authorize` | Start external OAuth connection flow |
| `POST` | `/platform-keys` | Issue a product API key through the configured provider |
| `GET` | `/telemetry/cost-per-verified-success` | Read the primary optimization metric |

Errors use `{ "error": "CODE", "message": "description" }`. Run creation returns HTTP 202. Event
streams use standard SSE `id`, `event`, and JSON `data` fields.

`POST /runs/:id/mode` remains an operator compatibility surface. Its values are persisted as
`EXTERNAL_HINT` evidence; collector-derived deterministic signals take precedence at the next
checkpoint. Unknown model cost is serialized as `null`, never inferred from a hard-coded price.

Budget: `BudgetAllocated` and `CostEstimated` events are emitted on the run's event stream at
creation — `BudgetAllocated.allocation` is `null` when no budget was configured (not `$0`), and
`CostEstimated.estimate` is `null` (not a guess) when there is no prior verified-success telemetry
to anchor a range to. A `HARD` budget that cannot fund even the first agent session results in the
run going straight to `PAUSED` with a `BUDGET_EXHAUSTED` recovery capsule, inspectable via
`GET /runs/:id/recovery-capsule`, without ever starting an agent.

Risk and assurance: `RiskProfiled` and `AssurancePlanned` events are emitted twice on the run's
event stream, tagged `stage: "pre-execution"` (right after context is built, from the initially
selected scope) and `stage: "diff-captured"` (once a candidate's actual diff exists, refining the
estimate with ground truth). `RiskProfiled.riskVector` always carries all ten dimensions, each with
a `level` and a `provenance` (`DETERMINISTIC`/`HEURISTIC`/`INSUFFICIENT_EVIDENCE` — never a guessed
value presented as fact). `AssurancePlanned.plan` lists `required`/`notRequired` checks with a
`reasons` entry for every check. `CORRECTNESS` is enforced by the trusted verifier;
`ARCHITECTURE`, `DEBT`, and `SECURITY` have deterministic diff-bound checkers; `PERFORMANCE` has a
candidate/digest-bound clean-baseline measurement boundary; and
`INDEPENDENT_REVIEW` has one bounded candidate/digest-bound reviewer session when required.
Missing/invalid performance evidence is `NOT_CHECKED` and blocks when required; a measured delta
over the project threshold is `FAIL`. `CONCURRENCY` and `RESILIENCE` still have no checker and remain
`UNKNOWN`, never a synthetic pass. `RuntimeGraphDerived` exposes the evidence-backed deployment
topology inferred from the candidate without conflating it with the source Project Graph.

Security redaction is applied before run/task errors, changed filenames/runtime signals,
verification output, recovery capsules, mode-transition evidence, events, and artifact previews
reach these routes. Reference-shaped fields preserve only validated `credential://` locators, and
secret-shaped durable execution locators are rejected on create. The M8 regression suite exercises
HTTP run, summary, verification, artifact, recovery-capsule, runtime-signal, and SSE-event data with
adjacent/encrypted PEM keys, generic credentials, adversarial filenames/references, and
secret-bearing failures. Uninspectable binary diff payloads are suppressed from artifact previews;
binary, gitlink, and rename/copy-only changes are reported as Security `NOT_CHECKED`, never PASS.
This is a tested harness-persistence boundary, not a claim of OS/network isolation or a guarantee
about arbitrary output written by external processes outside MAF's stores.
