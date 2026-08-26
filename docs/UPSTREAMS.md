# Upstream register

Upstreams were resolved through official project pages, tagged sources, or verified GitHub
organizations. Session 3 scanner/telemetry facts and Session 8 ecosystem decisions were refreshed on
2026-08-24. No upstream source, pricing dataset, index artifact, or scanner binary is vendored into
this repository.

| Project | Canonical repository | License | Audited revision/version | Purpose | Integration and updates |
| --- | --- | --- | --- | --- | --- |
| Agent Client Protocol TypeScript SDK | `agentclientprotocol/typescript-sdk` | Apache-2.0 | `7585334c5b738868583d561bdfc97caf77a3f3ba`; npm `1.3.0` | First-class interoperable agent transport | Pinned package dependency behind `AgentAdapter`; update after ACP conformance tests |
| codebase-memory-mcp | `DeusData/codebase-memory-mcp` | MIT | `46ae198fc11cda80e817acbc5f5908d7c2de7032` | Optional structural project graph | Explicit inactive optional port until transport is configured; deterministic local index reports itself as fallback |
| Aider | `Aider-AI/aider` | Apache-2.0 | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Repository-map algorithm reference | Reference-only; no copied files; compact map is independently implemented |
| ast-grep | `ast-grep/ast-grep` | MIT | `0eb08389b6c4c5f3e19f90efbcb726fc413ca63d`; npm `0.45.1` | Structural search | Pinned N-API package behind repository-index abstraction |
| Bifrost | `maximhq/bifrost` | Apache-2.0 | `1eaa6840b43571ecec892d6b8cfb78d8bb7c34cb` | Multi-provider LLM gateway | OpenAI-compatible HTTP service adapter; no server code embedded |
| Better Auth | `better-auth/better-auth` | MIT | `64da15b0b1ca078d80f115ee0a5bd9ad4ca4d64e`; npm `1.7.1` | User authentication and OAuth configuration | Pinned package behind `UserAuthProvider`; mock local session is separately labeled |
| Nango | `NangoHQ/nango` | Elastic-2.0 | `7d771c5399102457ba774b943e5d21e1c9aeb4b0` | External-service OAuth lifecycle | API client boundary only; never duplicate provider refresh tokens |
| Infisical Agent Vault | `Infisical/agent-vault` | MIT core; separate `ee/` license | `10743832e3dd362afd30c6e9b26b1732ed0d2766` | Broker provider secrets outside agent sandboxes | HTTP proxy/broker adapter; no enterprise code embedded |
| Unkey | `unkeyed/unkey` | AGPL-3.0 server; package-specific exceptions | `1dfa8b32df11e54655c85245e4a5a95abe21114b` | Future product-issued API keys | Port and schema only in V0; future deployment must receive a license review |
| Langfuse | `langfuse/langfuse` | MIT core; separate `ee/` terms | `v4.17.0` | Optional experiment/trace observability | **INTERFACE_SEAM_ONLY**: use vendor-neutral OTLP/HTTP, one-way and fail-open; Langfuse state is never MAF trust state |
| OpenTelemetry JS | `open-telemetry/opentelemetry-js` | Apache-2.0 | API npm `1.9.1`; trace SDK/resources npm `2.10.0`; OTLP proto exporter npm `0.221.0` | Vendor-neutral provider-execution traces | Exact-pinned trace-only SDK/exporter; isolated tracer, fixed resource, explicit endpoint opt-in, bounded attributes/shutdown, fail-open transport |
| Fluent UI | `microsoft/fluentui` | MIT; separate font/icon asset terms | `42f76ebac7435ab290cb3281ad065e939e51e1ee`; React npm `9.74.6` | Accessible operations dashboard | Pinned React v9 package; no licensed fonts or external icon assets copied |
| OSV-Scanner | `google/osv-scanner` | Apache-2.0 | `v2.5.1` | Exact dependency-vulnerability findings | Separately installed CLI, exact version probe, explicit changed `package-lock.json` pilot, MAF-owned config, no negative-absence authority |
| OpenGrep | `opengrep/opengrep` | LGPL-2.1 | `v1.27.1` | Exact configured static-analysis findings | Separately installed CLI; operator-owned local rules/manifest must match their digest; no registry rules, interfile alpha, or negative-absence authority |
| Betterleaks | `betterleaks/betterleaks` | MIT | `v1.8.1` | Future credential-scanner challenger | **CHALLENGER**, not integrated: active but rapidly evolving; future pilot must pin binary/rules, disable credential validation, redact, and retain unsupported negative coverage |
| Gitleaks | `gitleaks/gitleaks` | MIT | `v8.30.1` | Legacy optional credential-scanner comparator | **LEGACY_OPTIONAL**, not integrated: upstream declares the CLI feature-complete/security-fixes-only; do not confuse it with the separately licensed Action |
| SCIP | `scip-code/scip` | Apache-2.0 | `v0.9.0`; `scip-typescript` `v0.4.0` separately | Revision-bound symbol/reference navigation | **REAL_ADAPTER**: read-only bounded consumer of an operator-generated index and MAF digest manifest; indexers are never auto-run and graph output is `CONTEXT_ONLY` |
| Joern | `joernio/joern` | Apache-2.0 | `v4.0.610` | Future specialist code-property/data-flow analysis | **DEFER**: JDK 21/graph/query execution is too heavy for the current non-security sandbox; any revisit uses fixed MAF queries in hardened isolation |
| LiteLLM | `BerriAI/litellm` | MIT core; `enterprise/` excluded | `v1.98.0` | Provider/model pricing data | **REAL_ADAPTER** for operator-supplied `model_prices_and_context_window.json` only; no proxy/router, no network fetch, stale/missing/ambiguous price stays `UNKNOWN` |
| TencentDB Agent Memory | `TencentCloud/TencentDB-Agent-Memory` | MIT | `v2.0.0` | Optional layered memory/wiki/code-graph provider | **INTERFACE_SEAM_ONLY**: bounded retrieval may later sit behind ProjectBrain/Context OS; proxy prompt injection and memory-to-fact promotion are rejected |
| Dagger | `dagger/dagger` | Apache-2.0 | `v0.21.8` | Deterministic build-environment reference | **DESIGN_REFERENCE_ONLY**: content/environment identity is useful; the commonly privileged container engine is not a hostile-code security sandbox |
| E2B SDK / infra | `e2b-dev/E2B`, `e2b-dev/infra` | Apache-2.0 | JS `2.45.0`; infra `2026.29` | Future remote security-sandbox provider | **INTERFACE_SEAM_ONLY**: first widen the neutral sandbox-session contract for remote execution, transfer, egress, cancellation, and evidence identity |
| Temporal | `temporalio/temporal` | MIT | server `v1.31.2`; TypeScript SDK `v1.22.0` | Durable-workflow candidate | **DEFER**: it would duplicate/migrate MAF state semantics and add a production service cluster before crash-recovery value is benchmarked |
| Promptfoo | `promptfoo/promptfoo` | MIT | `0.122.0` | Future frozen-suite evolution evaluator | **INTERFACE_SEAM_ONLY**: existing `EvolutionEvaluationPort` is sufficient until real trajectories/benchmarks justify a restricted offline CLI adapter |
| OpenClaw | `openclaw/openclaw` | MIT | `v2026.7.1-2` stable | Gateway/channel/sandbox policy reference | **DESIGN_REFERENCE_ONLY**: borrow explicit backend/scope/network/elevation concepts; do not embed its personal-assistant control plane |
| Hermes Agent | `NousResearch/hermes-agent` | MIT | upstream `v0.20.5` (`v2026.8.19` tag); local probe `v0.18.2` | Optional ACP/native-agent compatibility candidate | **DEFER**: MAF's generic ACP path already exists; local dependency check passed, but the installed build is older/locally modified and no benchmark mission requires a provider binding |
| EvoAgentX | `ANative-Lab/EvoAgentX` | MIT | `v0.1.4` | Generated-workflow design reference | **DESIGN_REFERENCE_ONLY**: a future generator may emit an immutable challenger proposal, never mutate promoted policy or become production orchestrator |

Update procedure: fetch the canonical repository, inspect README/license/changelog at the proposed
revision, update the pinned dependency or service image separately, then run `npm run validate`.

Session 8 deliberately keeps Agent Lightning, DSPy, GEPA, and other optimizer runtimes **DEFERRED**
until MAF has real trajectory data, frozen evaluations, and benchmark evidence.

OSV-Scanner and OpenGrep executables, configurations, and rules are operator-trusted inputs, never
candidate-controlled inputs. The bounded runner terminates the observed process tree on timeout,
abort, or output overflow. Pure Node.js process groups cannot contain a deliberately hostile scanner
that starts a new detached job/session and exits successfully; hostile-binary containment requires an
OS job object, cgroup, or container boundary. Install verified artifacts atomically, keep their paths
outside candidate sandboxes, and restart the service after changing any scanner executable.
