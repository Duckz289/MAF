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

## Why graph, mission, and trust are separate

Repository relations change how code knowledge flows. Mission dependencies change how work flows.
Verification changes what may be trusted. Combining these into one tree would allow orchestration
structure to masquerade as repository evidence or verified output.

## Why external systems stay at the edge

ACP, Bifrost, Nango, Agent Vault, Langfuse, and Unkey solve different boundary problems. The harness
uses protocol or service adapters so their deployment, license, or API can change without rewriting
the domain controller.
