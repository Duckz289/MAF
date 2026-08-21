# Adaptive Agent Harness

A local-first control plane that wraps native coding agents without replacing their planning,
search, or context loops. It provides adaptive execution policy, isolated Git worktrees,
verification, structured repository knowledge, credential references, telemetry, and an operations
dashboard.

## Quick start

```powershell
npm install
npm run build
npm run start
```

Open `http://127.0.0.1:4310`. The default store is in-memory. For durable PostgreSQL state:

```powershell
docker compose up -d postgres
$env:DATABASE_URL = 'postgresql://harness:harness@127.0.0.1:54329/harness'
npm run migrate
npm run start
```

Run the complete local gate with `npm run validate`.

## Runtime intelligence

Adaptive mode changes are derived from repository and execution evidence rather than request-time
flags. The collector observes the initial context, native-agent tool events, captured diff, and
verification history. Every snapshot records per-signal provenance as `DETERMINISTIC`, `HEURISTIC`,
`AGENT_INFERENCE`, or `EXTERNAL_HINT`; request signals remain compatibility hints and cannot replace
deterministic measurements.

Inspect a run through `GET /api/v1/runs/:id/runtime-signals` and
`GET /api/v1/runs/:id/mode-explanation`, or select it in the operations dashboard.

## Native-agent and benchmark checks

Set `MAF_NATIVE_AGENT=claude` to use the installed Claude Code CLI through its native streaming
protocol. `npm run real-agent:smoke` runs a bounded, disposable Git-worktree check and reports the
provider's actual usage and cost metadata when available.

`npm run benchmark -- <manifest.json>` compares external `NATIVE` and `MAF_ADAPTIVE` executors.
Executor-reported cost is preserved; missing cost stays `null` and is excluded from cost-per-verified
success. `npm run benchmark:fixture` exercises report generation with a deterministic local file
verification fixture, not an agent-performance claim.

`npm run benchmark:integrated-fixture` runs the ten M15 scenario families through deterministic
local policy-path probes and a ten-checkpoint, per-strategy Git state chain. The runner rejects
label-only family coverage, non-advancing/unbound checkpoint digests, orphan N+1 comparisons,
impossible verification counters, and discontinuous mode transitions. This is
`PARTIALLY_VERIFIED`: it verifies orchestration, evidence binding, and local domain invariants, but
it is not a paid-model quality comparison, production load test, or evidence that MAF beats the
native frontier. All family checks and state digests remain executor-reported evidence; the report
labels that boundary and makes no causal claim from changeability deltas.

## Capability status

- `VERIFIED`: local deterministic execution, candidate verification and quality gates, bounded
  recovery/budget policy, health/strategy/delivery/production-evidence persistence, and the
  repository-native validation gate.
- `PARTIALLY_VERIFIED`: the integrated benchmark fixture and ten-checkpoint changeability path;
  they exercise real local state chaining and policy rules with synthetic/local inputs, not real
  frontier model performance or production traffic.
- `EXPERIMENTAL`: explicit strategy assessment/selection. Automatic routing of run creation is not
  enabled, and benchmark shadow evidence cannot promote a production strategy.
- `NOT_VERIFIED`: live CI provider polling, live observability collection, real-agent comparative
  benchmark results, automatic merge/deployment, and cross-process automatic resume.
- `KNOWN_LIMITATION`: CLI-reported cost is not independently metered; structural health trends stay
  `UNKNOWN` without proven repository-state ancestry; no production claim follows from fixture
  success.
