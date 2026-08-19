# Adaptive control-plane decisions

## Why a modular monolith

The V0 needs strong boundaries, not a fleet of services. A single TypeScript process keeps run
orchestration, policy, and API changes atomic while ports isolate Git, PostgreSQL, agents, gateways,
auth, and telemetry. Service separation can follow measured load or security requirements.

## Why native loops remain native

ACP and CLI adapters transport prompts, updates, cancellation, and session identity. They do not
rebuild planning or repository exploration. Guided context is explicitly a starting point. This
keeps agent-specific planning, context compression, OAuth, and subagent abilities available.

## Why transitions are events

A mode value without its reason cannot be debugged or benchmarked. `ModeChanged` is therefore a
first-class event with evidence. Deterministic signals come first; a future model may propose a
transition, but the accepted decision must still be persisted.

## Runtime signal provenance

The controller consumes immutable snapshots, not mutable request fields. Deterministic measurements
win over external hints, while heuristic and agent-inference values retain their lower reliability
labels. A cross-module edge counts only when the local repository index resolves a unique import
between different modules and both endpoint files are involved in the observed scope. Snapshot and
evidence IDs link each decision to the observations that caused it.

Module ownership is also deterministic. Tracked nested package manifests, root `package.json`
workspace entries, simple `pnpm-workspace.yaml` entries, and conventional `apps`, `packages`, and
`services` roots identify package boundaries. Otherwise `src/<layer>` is an architectural module and
`src/features/<feature>` is a feature module. Files inside one owner do not create cross-module
edges. This deliberately does not attempt compiler alias resolution or framework-specific graph
inference.

## Adaptive transition policy

- `GUIDED -> SOLO_NATIVE`: uncertainty is at least `0.7`, dependency or cross-module expansion is at
  least `3`, at least `4` modules are involved, or trusted verifier failures reach `2`.
- `GUIDED -> STRICT` and `SOLO_NATIVE -> STRICT`: the multi-signal stabilization and conservative
  mechanical-work heuristics are both true outside the three-observation cooldown.
- `STRICT -> GUIDED`: a small positive delta from the snapshot that entered `STRICT` appears in
  modules, dependencies, cross-module edges, context, verifier failures, or stabilization
  invalidations.
- `STRICT -> SOLO_NATIVE`: re-expansion is significant: at least `2` new modules/dependencies/edges,
  at least `3` context files, `2` trusted failures, or materially high uncertainty.

Leaving `STRICT` is not blocked by cooldown because the transition requires explicit invalidation
evidence. The cooldown does block an adjacent return to `STRICT` and blocks escalation based only on
unchanged cumulative counters.

## Stabilization and evidence priority

Stabilization requires five meaningful observations with no new files, modules, cross-module edges,
or verifier failures, a non-empty observed module set, and a bounded edit target set. Mechanical work
also requires at least two structurally equivalent edit operations, no more than three target files,
no unresolved verifier failure, and uncertainty no greater than `0.5`. Both remain `HEURISTIC` with
medium reliability.

Deterministic repository and verifier facts cannot be overridden by `AGENT_INFERENCE` or
`EXTERNAL_HINT`. An agent or request may conservatively reject mechanical narrowing, but cannot
assert it when observed scope is unstable.

## Bounded verification repair

V0.1.1 permits one repair after the first failed verification, for at most two verification attempts.
The repair input contains the command or expected file, exit code, bounded output, candidate files,
diff digest, and bounded diff preview. A native session is resumed only if an adapter honestly
advertises and implements resume; current CLI, ACP, and Claude benchmark adapters advertise `false`,
so they use a new bounded session in the same worktree. Each candidate artifact records its attempt
and parent candidate ID. The verifier remains authoritative, and a second failure is quarantined.

Persistent recovery state, provider/model failover, cross-process resume, budget recovery, and
circuit breakers remain deferred to Recovery V0.2.

## Why graph, mission, and trust are separate

Repository relations change how code knowledge flows. Mission dependencies change how work flows.
Verification changes what may be trusted. Combining these into one tree would allow orchestration
structure to masquerade as repository evidence or verified output.

## Why external systems stay at the edge

ACP, Bifrost, Nango, Agent Vault, Langfuse, and Unkey solve different boundary problems. The harness
uses protocol or service adapters so their deployment, license, or API can change without rewriting
the domain controller.
