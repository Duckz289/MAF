# Session 8 — Selective ecosystem capabilities

Status: COMPLETE (implemented and fully validated on 2026-08-24)

Decision authority: for the ecosystem candidates re-evaluated here, this Session 8 matrix supersedes
the earlier provisional decisions in §4 of `maf-v2-integration-architecture.md`. That older active
plan remains relevant to its wider integration sequence, but its candidate labels are not the
current adoption decision.

## Objective and constitution

Session 8 integrates only an external capability that closes a demonstrated current MAF gap. MAF
continues to own mission, context, strategy, evidence, verification, transition, and trust semantics.
The selection rule is Minimum Effective Intervention, Minimum Effective Context, and Minimum
Effective Assurance.

The frozen implementation choices are:

- a real, optional, read-only SCIP repository-intelligence adapter;
- a real, optional, offline LiteLLM pricing-data adapter;
- no external control plane, memory authority, router, durable workflow runtime, or optimizer;
- no automatic production strategy/model routing.

External graph output is navigation intelligence with `CONTEXT_ONLY` authority. External pricing is
an estimate input, never execution authority. Provider absence or silence cannot strengthen trust,
close an assurance obligation, or cause an execution-mode transition.

## Dirty overlay and baseline

- Branch: `adaptive-harness/runtime-signals-v0.1`
- HEAD: `9ff934e53424501098c5dd4da01cfabe987e7d67`
- Pre-session overlay: 148 status entries, each captured with presence and SHA-256 before edits.
- Baseline `npm run validate`: PASS — 73 test files passed, 4 skipped; 1002 tests passed, 8 skipped;
  typecheck, lint, formatting, builds, compose configuration, and smoke all passed.
- Prohibited operations remain prohibited: no reset, clean, stash, checkout-away, broad reformat,
  commit, or push.

## Current capability-gap audit

| Area | Current evidence | Concrete gap / Session 8 disposition |
| --- | --- | --- |
| Context OS | Bounded handles/pages, digest revalidation, `CONTEXT_ONLY`, prompt consumes only Working Set | No semantic symbol/reference navigation. Close through optional repository-intelligence pages. |
| Repository intelligence | Local JS/TS declaration regex and resolved relative imports | No semantic IDs, references, definitions, implementations, callers/callees, or non-JS intelligence. SCIP closes only the capabilities its index explicitly records. |
| Model/pricing | Canonical model identity/cost and an unwired `ModelPricingCatalog` | No concrete independent price source or freshness provenance. Close with offline pinned LiteLLM data. |
| Sandboxing | Local worktree transaction boundary; Docker provider is not implemented | No process/network security isolation or remote execution contract. Keep E2B at seam level and OpenClaw as a policy reference. |
| Deterministic verification | Candidate/revision-bound commands and evidence capture | Host environment identity and crash-safe verifier execution remain incomplete. Dagger is reference-only. |
| Project memory | Evidence-bound built-in Brain works in memory/PostgreSQL | Optional external backend is inactive, but correctness does not require one. Keep Tencent behind the neutral seam. |
| Observability/evaluation | MAF ledger/telemetry, isolated OTLP capability traces, frozen evaluation contracts | Whole-run OTLP and real benchmark trajectories remain future work. Do not add a second observability authority or evaluator runtime yet. |
| Durable execution | PostgreSQL state and recovery capsules exist | No leases/heartbeats/startup reconciliation for mid-run process loss. Temporal's migration/cluster cost exceeds current demonstrated value. |
| Agent transport | Native CLI and ACP v1 adapters exist | ACP resume/multi-provider lifecycle is incomplete. Hermes does not solve durable recovery and is deferred pending a benchmark need. |

## Current upstream decision matrix

Primary sources were checked on 2026-08-24. Release/version facts below are source-supported; where
security audits, compatibility guarantees, hosted residency, or complete operational behavior were
not established, they remain `UNVERIFIED_UPSTREAM`.

| System | Decision | Current verified boundary | MAF reason and “do not use” condition |
| --- | --- | --- | --- |
| [SCIP](https://github.com/scip-code/scip) | **REAL_ADAPTER** | Apache-2.0, `v0.9.0`; language-neutral protobuf index; indexers are separate | Closes the exact symbol/reference gap. Do not invoke for trivial work needing no semantic navigation, and never auto-run an indexer. |
| [Joern](https://github.com/joernio/joern) | **DEFER** | Apache-2.0, `v4.0.610`; JDK 21 CPG/Scala/CLI/server | Rich data/control flow is valuable but unsafe/heavy under the current host-process sandbox. Do not use for ordinary edits or expose repository-authored queries. |
| [LiteLLM](https://github.com/BerriAI/litellm) | **REAL_ADAPTER** | MIT core, `v1.98.0`; current model price/context dataset plus optional SDK/proxy | Use the dataset only. Do not deploy its router/proxy for strategy, fetch mutable main at runtime, or price native subscription execution as API usage. |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | **INTERFACE_SEAM_ONLY** | MIT, `v2.0.0`; Core/Hub/Proxy plus SDK/HTTP | Built-in Brain already defines correctness. Do not proxy-inject prompts or convert memory into verified fact/trust. |
| [Dagger](https://github.com/dagger/dagger) | **DESIGN_REFERENCE_ONLY** | Apache-2.0, `v0.21.8`; engine/SDK/GraphQL/container functions | Content-addressed environment identity is useful; privileged engine burden does not justify integration. Do not treat it as hostile-code isolation or trust. |
| [E2B SDK/infra](https://github.com/e2b-dev/E2B) | **INTERFACE_SEAM_ONLY** | Apache-2.0; JS `2.45.0`, infra `2026.29`; hosted API or Firecracker-based self-host stack | A remote adapter needs a wider neutral sandbox-session contract and explicit residency/egress policy. Do not replace local worktrees for ordinary local verification. |
| [Temporal](https://github.com/temporalio/temporal) | **DEFER** | MIT; server `v1.31.2`, TS SDK `v1.22.0`; Cloud/self-host gRPC services | Crash recovery is a gap, but a workflow rewrite and production cluster duplicate current state semantics. Do not replace functioning MAF durability without benchmark evidence. |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | **INTERFACE_SEAM_ONLY** | MIT, `0.122.0`; Node CLI/library with structured result formats | Existing `EvolutionEvaluationPort` is enough before trajectories/benchmarks. Do not execute arbitrary custom assertions/config code or grant promotion authority. |
| [Langfuse](https://github.com/langfuse/langfuse) | **INTERFACE_SEAM_ONLY** | MIT core, `v4.17.0`; OTLP/HTTP plus multi-service self-host stack | Standard OTLP already covers the replaceable boundary. Do not duplicate MAF's evidence ledger or make export failure affect a run. |
| [OpenClaw](https://github.com/openclaw/openclaw) | **DESIGN_REFERENCE_ONLY** | MIT, `v2026.7.1-2`; trusted-operator Gateway with optional sandboxes | Useful explicit backend/scope/network/elevation policy. Do not embed its personal-assistant control plane or use one gateway as hostile multi-tenancy. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | **DEFER** | MIT; upstream `v0.20.5`/tag `v2026.8.19`; ACP/JSON-RPC/HTTP boundaries | Generic ACP already exists. Local `v0.18.2` (locally modified) passed dependency check but is not the audited release. Do not bind a provider before a benchmark mission needs it. |
| [EvoAgentX](https://github.com/ANative-Lab/EvoAgentX) | **DESIGN_REFERENCE_ONLY** | MIT, `v0.1.4`; in-process Python workflow generation/evolution | A generator may later emit an immutable challenger proposal. Do not make it production orchestrator or let it mutate promoted policy. |

Agent Lightning, DSPy, GEPA, and other optimizer runtimes are **DEFERRED** until MAF has real
trajectories, frozen evaluations, and benchmark evidence.

## Tencent mechanism classification

- **ADOPT_INTO_MAF_SEMANTICS**: hierarchical progressive disclosure; deterministic abstraction to
  raw-evidence drill-down; explicit owner/version/status/visibility metadata.
- **ADAPT_BEHIND_PROVIDER**: bounded wiki/code-graph/memory retrieval, rebound to MAF project,
  revision, digest, freshness, and `CONTEXT_ONLY` authority.
- **KEEP_TENCENT_SPECIFIC**: L0–L3 persona/scenario taxonomy, Memory Hub/Proxy, Agent Loadout,
  `x-tdai-user-key`, and three-container topology.
- **REJECT**: automatic proxy prompt injection; memory-to-`FACT`/`DECISION`/`PRODUCTION`; Tencent
  status/ACL as MAF trust; exporting raw prompts/logs by default.

## Repository-intelligence contract

The canonical path is:

```text
Prompt or native agent requests more context
  -> bounded ContextPageRequest
  -> ContextNavigationService
  -> LocalContextPageSource
  -> RepositoryIntelligenceProvider
  -> bounded canonical locations
  -> current path + document-digest revalidation
  -> CONTEXT_ONLY ContextPage
  -> ContextWorkingSet
  -> PromptCompiler
```

The canonical contract supports `FIND_SYMBOL`, `FIND_DEFINITION`, `FIND_REFERENCES`, and
`FIND_IMPLEMENTATIONS`. It carries no SCIP types or raw SCIP symbol identifier. A repository locator
binds project/revision/source identity/version/indexed time/completeness/languages. Returned locations
bind a canonical URI and exact document SHA-256. Lines are one-based and characters are zero-based.

The SCIP adapter consumes only an operator-generated `index.scip` plus a MAF-owned manifest. The
manifest binds index digest, project/revision, indexer identity/version, age, completeness, languages,
and per-document digest. It never installs dependencies, invokes an indexer, uploads source, or reads
candidate-controlled configuration. Large graphs remain cold; a configured provider contributes one
fixed locator, and only an explicit page request materializes bounded results. Query-time reading
physically contains the artifact under the manifest directory, verifies and reads one read-only file
handle, checks deadlines through post-decode work, and retains deterministic bounded top-K results.
Indexer identity is asserted and checked; separate indexer certification remains required and was not
fabricated by this session.

The operator-owned manifest is strict version-1 JSON and the index path is relative to the manifest:

```json
{
  "manifestVersion": 1,
  "projectId": "<canonical-maf-project-id>",
  "revision": "<resolved-source-commit>",
  "indexPath": "index.scip",
  "indexSha256": "<64-lowercase-hex>",
  "sourceId": "scip-code/scip",
  "sourceVersion": "v0.9.0",
  "indexedAt": "2026-08-24T00:00:00.000Z",
  "maxAgeMs": 604800000,
  "completeness": "COMPLETE",
  "languages": ["typescript"],
  "expectedIndexer": { "name": "scip-typescript", "version": "0.4.0" },
  "documents": [{ "uri": "src/example.ts", "sha256": "<64-lowercase-hex>" }]
}
```

Provider outcomes remain distinct: `UNAVAILABLE`, `UNSUPPORTED`, `TIMEOUT`, `MALFORMED`, `PARTIAL`,
`STALE`, and `VERSION_MISMATCH`. A completed no-match page says that no location was observed and is
not proof of absence. A partial page is visibly truncated. Every non-result failure is rejected and
cannot strengthen trust.

## Pricing contract

The LiteLLM adapter consumes only caller/operator-supplied JSON bytes or a plain object. It performs
no network request and exposes no routing operation. Exact source digest, caller version, source
update time, load time, maximum age, and estimate reason remain in metadata/provenance. Only
unambiguous provider/model `API_GATEWAY` identities with supported input/output/cache-read prices are
estimated. Missing provider usage and unimplemented automatic token-price tiers fail closed. Missing,
stale, malformed, ambiguous, incomplete, non-API, or unsupported data is reasoned `UNKNOWN` with
`amountUsd: null`.

## Lightweight provider certification record

| Provider | Capability/scope | Failure/completeness | Runtime/license | Regression environment | Last regression |
| --- | --- | --- | --- | --- | --- |
| SCIP/scip-code `v0.9.0` | Read-only local SCIP artifact; symbols/definitions/direct references/explicit implementations; bounded canonical pages | All seven required failure classes; source `COMPLETE/PARTIAL/UNKNOWN`; result clipping is explicit | Node 22 consumer; separately generated index; Apache-2.0 | Hermetic protobuf fixtures on Windows/Node 22; live external indexer unavailable and must remain `NOT_EXECUTED` | **PASS**, 2026-08-24: 16/16 focused adapter tests; included in full validation |
| LiteLLM `v1.98.0` data shape | Offline model pricing for unambiguous API provider/model and supported token components | Reasoned `UNKNOWN`; stale/malformed/ambiguous never zero; estimates are not billing authority | Node 22; operator-supplied JSON; MIT core, enterprise excluded | Hermetic pricing fixtures on Windows/Node 22; tagged upstream data-shape check executed; mutable upstream is not a runtime dependency | **PASS**, 2026-08-24: 14/14 focused pricing tests; included in full validation |

## Strategy, transition, and trust non-change

No provider availability is wired to production execution-mode or model routing. No automatic learned
routing is enabled. Session 8 adds no transition branch in `RunService`; consequently it emits no new
execution-mode transition. Existing transitions remain subject to their Session 5–7 reason/evidence
requirements and verified-only handoffs. Repository graph and price availability remain advisory
context/data only.

## Validation record

- Focused adapter results: SCIP **16/16**, LiteLLM pricing **14/14**, and provider-neutral Context OS
  integration **5/5**. The final Session 8/context/vendor-focused set passed **55/55**.
- The Session 7 Mission/Prompt/Skill/Cost/Evolution, capability-provider, trust/evidence
  conservation, and RunService focused regression set passed **21 files / 258 tests**.
- Final `npm run validate`: **PASS** — format checked 217 files; lint completed with the same 13
  warnings and 6 informational diagnostics present at baseline; typecheck passed; **76 test files
  passed, 4 skipped; 1,037 tests passed, 8 skipped**; server/UI builds, compose configuration, and
  smoke passed.
- Exact Session 8 files were formatted; no broad reformat was run. `git diff --check`: **PASS**.
- Normal validation ran with Session 8 integrations disabled by default, preserving basic local
  correctness and boot behavior.
- `EXECUTED`: hermetic adapters, tagged LiteLLM `v1.98.0` data-shape compatibility, and local Hermes
  dependency/ACP checks. `ENVIRONMENTAL / NOT_EXECUTED`: live SCIP indexer and all other absent
  external binaries/services. Independent audits, hosted residency, and untested production
  deployment properties remain `UNVERIFIED_UPSTREAM`.

## Final dirty-overlay attribution

The final overlay has 155 all-file status entries: the original 148 plus exactly seven Session 8
files. Branch and HEAD are unchanged. Exactly the ten intended pre-existing files changed hash; no
other baseline hash changed, and no baseline dirty path became clean or missing. Attribution is
therefore safe at the current scale.

| Existing file | Pre-session SHA-256 | Final SHA-256 |
| --- | --- | --- |
| `.env.example` | `72f3dfb137875e713c228788a82e1cbea4077c0b51fef76e7f4c8d9bbfca6b56` | `4812b3118b46974f5fdf34115f988e28442371861c2cbc4666cddefd32333961` |
| `ARCHITECTURE.md` | `a1a6d3fb905c8a3e41312fe0a3b06d1dfb559bdb3ac7262fcfdae63f2e126b2b` | `4cd454ac5a0c2d74308d8ec2d985781e38478e1f633b4b5efd06a46dc165ec16` |
| `docs/UPSTREAMS.md` | `358d771621d3df68e74b86d94ab4fce7274a829b3c90d9b3f8d84e88a6ffb31b` | `6ad7cf9053a6f681531805bb4996a350b393c12cd9adac2c5da4899131a84491` |
| `src/application/context-builder.ts` | `4a4bae98e9f9bd1004eb1468b894d59532d91eb841a8a199b4b23b431398cf4b` | `a5dec031ea1a6adf777f445626947af66e41db413259b5e36a002c7540bf943f` |
| `src/application/context-navigation.ts` | `7c5f7639282ac6c0b57f44cec143008ce1e436138a7e18bdd4599f2fbbaf4014` | `5408f010609c3e77a3c4fbae3dd8020e7e384ba9a8866269eb82dd8b29be52d3` |
| `src/domain/context-navigation.ts` | `709c70697deac1ad60bc2d95780efaf15ab0faa8e3df7d284609e964277e7c4b` | `b7d4a35f19f651867d8ec05709eb7f35c62c13f05889d5af244fea990696a168` |
| `src/infrastructure/context-page-source.ts` | `5a6a20d814ab149d4ddc53a00e7efc13c1f9cc4d0e77ac215b1008f7514afddb` | `ee95feecc4db75c42f3615d4a645ca43948a5585d498ccc44bdaf6eb3caa0d79` |
| `src/infrastructure/model-gateway.ts` | `7b14b02c17e7be3633e13d6670034e347454644795b5869eeb0061546f47b20b` | `e429f2371c997b186a56a8eca71272bfc65b3183c9a9ee8a0f5e338e13a6ef52` |
| `src/server/app.ts` | `df31d72c5b666c7a616d34e2d5d4d3d632e0b711e3c6e9c674dd17a4a22d2d07` | `bc69c04074826024c8e272d9ba32d30874d16b8b714be621ab4111250bec75b6` |
| `tests/no-vendor-leak.test.ts` | `5c1413d2f1f42243cc1c369c7ee28e236c9d6f55a6f72b6d4f3848f9070a05cd` | `491163dc49a8cdc032f76b97a5fd63db8bae1ba55d832858770d1bd5b23d82eb` |

Session 8 created only:

- `docs/exec-plans/active/selective-ecosystem-capabilities-session-8.md`
- `src/domain/repository-intelligence.ts`
- `src/infrastructure/litellm-pricing-catalog.ts`
- `src/infrastructure/providers/scip-repository-intelligence-adapter.ts`
- `tests/litellm-pricing-catalog.test.ts`
- `tests/scip-repository-intelligence-adapter.test.ts`
- `tests/session-8-context-repository-intelligence.integration.test.ts`
