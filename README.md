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
