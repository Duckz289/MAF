# MAF v2 — Integration Architecture

Status: ACTIVE. The Session 1 reconnaissance remains as a historical baseline; the implementation
sequence and decision tables below record the completed Session 2 foundation and Session 3 wave.
Nothing has been committed by these architecture sessions.

Author: principal architect session, 2026-08-24.

---

## 0. Reconnaissance record

| Fact | Value |
|---|---|
| Branch | `adaptive-harness/runtime-signals-v0.1` |
| HEAD | `9ff934e` — `feat(web): suggest detected verification commands in task creation` |
| Working tree | **DIRTY — 89 entries.** 88 modified tracked files + 1 untracked (`Grok Build.lnk`) |
| Package name | `adaptive-agent-harness` v0.1.0, ESM, Node >= 22 |
| Source size | 31,244 LOC TS/TSX; domain 12,738; app+infra+server 10,717 |
| Runtime deps | 12 only: acp-sdk, ast-grep/napi, fastify(+static), fluentui, otel-api, better-auth, pg, react, zod |
| Milestones | M1–M14 DONE (VERIFIED). M15 DONE impl / **PARTIALLY_VERIFIED external evidence**. Plus 7 hardening passes. |
| Migrations | 001–010 (010 = harness control state) |
| Tests | 59 test files, unit + integration |

**The dirty tree is another session's concurrent work** (memory: Connections/server/app.ts). I read
files; I wrote exactly one new file (this document). No `git add`, no stash, no checkout.

### Disagreement #1 — with the brief's premise

The brief says "design the integration architecture for the next evolution." Repository evidence says
the v1 program is **not closed**: M15 external evidence is `PARTIALLY_VERIFIED`, and the tree has 88
uncommitted modifications from a live session. Starting provider work on top of an uncommitted
88-file delta will produce merge chaos and unattributable test failures.

**Recommendation: Phase 0 is not a feature. It is "land or abandon the current delta, close M15
external evidence, tag a baseline."** Everything below assumes a clean tree at a tagged commit.

---

## 1. Current architecture map

```
src/server/app.ts (826 LOC)          ← composition root + HTTP; the ONLY wiring point
        │
src/application/                      ← orchestration
  run-service.ts (3200 LOC)           ← the kernel; 21-dependency injection struct
  context-builder.ts (93)             ← GuidedContextBuilder
  runtime-signal-collector.ts (626)
  file-candidates.ts (33) · mission-registry (51) · project-registry (76)
        │
src/domain/ (34 files, 0 I/O)         ← pure judgment. ports.ts = 40 interfaces
        │
src/infrastructure/ (18 files)        ← adapters
  local-worktree · verifier · resilience-verifier · performance-verifier
  model-gateway · project-brain · telemetry · memory-store · postgres/store
  claude-code / codex-cli / antigravity-cli / acp / native-cli adapters
```

**The layering is real and clean.** Verified by grep: zero occurrences of `semgrep|gitleaks|osv|
trivy|joern|scip|snyk|codeql` anywhere in `src/`. The single third-party import in domain-adjacent
code is `@opentelemetry/api` in `infrastructure/telemetry.ts:1` — correctly quarantined in infra.

This is the most important finding in the whole reconnaissance: **MAF has no anti-corruption debt to
pay off. The provider layer is greenfield inside an already-correct hexagon.**

### RunServiceDependencies — the existing capability seam

```ts
store, agent, sandbox, verifier,
performanceVerifier?, resilienceVerifier?,     // ← already optional capabilities
repositoryIndex, projectBrain, contextBuilder,
telemetry, runtimeSignals,
modeController?, repairPolicy?, enforcementPolicy?, recoveryPolicy?,
budgetReservationPolicy?, circuitBreaker?,
ciEvidenceVerifier?, productionFeedbackVerifier?  // ← already optional providers
```

Optionality is already modelled as `?:` + honest absence. The v2 provider architecture is a
**generalization of a pattern already present**, not a new idea imposed from outside.

---

## 2. Current trust / control boundaries

MAF's trust vocabulary is its crown jewel. It is already stricter than most of the tools we are
about to integrate.

```ts
// assurance-obligation.ts:70
ObligationStatus = PASS | FAIL | WARN | UNKNOWN | NOT_CHECKED | UNSUPPORTED | NOT_REQUIRED
// assurance.ts:28
AnalysisCoverage = FULL | PARTIAL | UNSUPPORTED | NOT_APPLICABLE
// capability-adequacy.ts:72,89
EvidenceClaim    = POSITIVE_FINDING | NEGATIVE_ABSENCE
EvidenceStrength = LEXICAL | STRUCTURAL | BEHAVIORAL | MEASURED
// types.ts:47
TrustState = PROPOSED → CORRECTNESS_VERIFIED → QUALITY_VERIFIED → DURABLE_VERIFIED → MERGE_ELIGIBLE
```

Enforcement is structural, not advisory:

- `assurance-obligation.ts:224` — `isResolved = status === "PASS" || status === "NOT_REQUIRED"`.
  UNKNOWN/NOT_CHECKED/UNSUPPORTED cannot resolve an obligation. **"Unknown != pass" is a type-level
  fact, not a convention.**
- `assurance-obligation.ts:63` — UNSUPPORTED is deliberately distinct from NOT_CHECKED so
  *"we did not look"* and *"we cannot look"* never collapse.
- `capability-adequacy.ts:179` — `negativeCoverage` separate from `coverage`. **Detection strength
  ≠ absence-proof strength.** A scanner may be FULL at finding secrets and UNSUPPORTED at proving
  there are none.
- `assurance-obligation.ts:81` — "Capabilities are never aspirational: a check with no capability is
  represented by the *absence of an entry*, not by a capability that claims it."

That last line is the entire integration doctrine, already written down. Every decision below obeys
it.

### Existing capability registry (the plug points)

```ts
CORRECTNESS.TRUSTED_COMMAND · ARCHITECTURE.LAYER_BOUNDARY · DEBT.DECLARED_MARKER_DELTA
SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN · SECURITY.CREDENTIAL_LITERAL_SCAN
SECURITY.CONCERN_DISCOVERY · SECURITY.SEMANTIC_FLOW_SCAN
SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER
PERFORMANCE.MEASURED_METRIC · RESILIENCE.FAULT_SCENARIO_EXECUTION
RESILIENCE.CODE_RELEVANCE_SCAN · REVIEW.FRESH_CONTEXT_SESSION
DISCOVERY.CONCERN_WITNESS · DISCOVERY.BOUNDED_CHANGE_CLASSIFIER
INTEGRATION → null   CONCURRENCY → null   (explicitly, honestly null)
```

---

## 3. Identified architectural debt

| # | Debt | Evidence | Severity |
|---|---|---|---|
| D1 | `run-service.ts` is 3,200 LOC with 21 injected deps — a god-orchestrator | file size | **HIGH** — every new provider makes it worse |
| D2 | `ModelGateway.estimateCost()` returns `null` unconditionally | `model-gateway.ts:77-83` | **HIGH** — budget authority (M4) rests on a stub |
| D3 | No model routing whatsoever; `BifrostModelGateway` posts to one `baseUrl` | `model-gateway.ts:38` | MEDIUM |
| D4 | `GuidedContextBuilder` is a **prompt dump**: top-N modules × 8 files, ≤60 symbols, ≤30 facts, `length/4` token estimate | `context-builder.ts:55-88` | **HIGH** — this is exactly what "navigate, don't load" must replace |
| D5 | `DockerSandbox` throws on every method | `local-worktree.ts:82-90` | MEDIUM — no isolation ceiling above git worktree |
| D6 | Sandbox = bare `git worktree`. No network isolation, no resource limits, no syscall boundary | `local-worktree.ts:33-39` | **HIGH** for untrusted-repo use |
| D7 | Security capability is regex/AST-local only; `doesNotEstablish` admits "cross-file data flow" | `assurance-obligation.ts:140` | MEDIUM — the honest gap v2 fills |
| D8 | `src/web/types.ts` hand-copies domain types | file exists | LOW |
| D9 | Verifier shell-detects `powershell` vs `/bin/sh` inline | `verifier.ts:7-10` | LOW |

**D2 + D4 are the two that actually block v2.** Cost architecture and context architecture both rest
on stubs today.

---

## 4. Third-party decision matrix

Classification key: **INTEGRATE** (ships in prod, adapter written) · **ADAPT** (contract designed,
adapter deferred) · **OPTIONAL_PROVIDER** (opt-in, absent by default) · **DESIGN_REFERENCE_ONLY** ·
**REJECT**.

### 4.1 Security / supply chain

| System | Decision | Rationale (evidence) |
|---|---|---|
| **google/osv-scanner** | **INTEGRATED_OPTIONAL** | Apache-2.0, pinned `v2.5.1`. Session 3 invokes a separately installed CLI only for explicit changed `package-lock.json` files with a MAF-owned configuration. Exact positive findings enter one dependency-vulnerability concern; silence remains UNSUPPORTED because source-language coverage cannot represent dependency inventory scope. |
| **gitleaks** | **LEGACY_OPTIONAL** *(not integrated)* | MIT CLI, `v8.30.1`. Upstream declares it feature-complete with security fixes only while work moves to Betterleaks. Retain only as a possible opt-in comparator; the separately licensed Action is not the CLI. |
| **betterleaks** | **CHALLENGER** *(not integrated)* | MIT, current `v1.8.1`, active releases. Rapid rules/interface evolution and optional live credential validation make it a shadow challenger, not a canonical provider. Any future pilot must pin binary/rules, disable validation, redact output, and grant no negative-absence authority. |
| **semgrep** | **REJECT as primary** | LGPL-2.1 engine, but the CE engine "can only analyze code within the boundaries of a single function or file" and upstream itself warns it "will miss many true positives." The cross-file/dataflow analysis MAF actually needs is the **paid** product, and the 20,000-rule registry is proprietary. Depending on it means either a weak checker or a commercial dependency. |
| **opengrep** | **INTEGRATED_OPTIONAL** *(defense in depth)* | LGPL-2.1 engine, pinned stable `v1.27.1`, invoked out of process. The former official rules repository is archived and not a production rules authority, so MAF ships no rules: operators must supply an audited local file plus exact manifest/digest. Stable intrafile analysis may emit exact positive findings; clean output has no negative authority. Interfile alpha is excluded. |
| **scip** | **ADAPT** | Apache-2.0, stable `scip.proto`, **machine-generated TypeScript bindings exist**, `scip-typescript` covers our own stack. The right long-term substrate for cross-file symbol navigation (§6, L3). Contract now, adapter in Phase 4. |
| **joern** | **OPTIONAL_PROVIDER** | Apache-2.0 and genuinely the strongest CPG/dataflow engine. **But: JDK 21 + Scala 3 + a graph DB, queried in a Scala DSL.** That is a heavyweight operational dependency for a self-hosted product. Perfect as an opt-in deep-analysis provider for CRITICAL tasks; never a default. |

**Doctrine for all scanners:** a scanner returning zero findings sets
`claim: NEGATIVE_ABSENCE, negativeCoverage: UNSUPPORTED` unless it can prove it read the material.
This is already enforceable via `capability-adequacy.ts`. *External Scanner CLEAN != candidate secure*
becomes a type, not a slogan.

### 4.2 Execution / durability / sandbox

| System | Decision | Rationale |
|---|---|---|
| **temporal + sdk-typescript** | **REJECT** | MIT, but requires **running a Temporal cluster** (server + persistence + workers). The TS SDK needs `worker_threads` + `vm` for the Workflow Sandbox and imposes determinism constraints on workflow code. MAF already has durable run state in Postgres (migrations 001–010), recovery capsules, and bounded retry. Temporal would replace working, owned machinery with a distributed system to operate. **"Intellectually large, operationally small"** forbids this. Revisit only for multi-tenant cloud MAF. |
| **e2b** | **OPTIONAL_PROVIDER** | Genuine microVM isolation — the real answer to D6. But effectively cloud-first with a usage-based cost model. Correct as an opt-in `SandboxProvider` for untrusted repositories; must not become required for local single-user MAF. |
| **dagger** | **DESIGN_REFERENCE_ONLY** | Requires a BuildKit/Docker engine daemon. Its hermetic-execution *model* is instructive for the verification boundary; adopting the engine is disproportionate. |
| **opentelemetry-collector-contrib** | **OPTIONAL_DESTINATION** | Session 3 pins the Node trace SDK/resources `2.10.0` and OTLP/proto exporter `0.221.0`; a collector remains optional. Export uses an isolated provider-owned tracer with fixed resource metadata, requires an explicit endpoint, is fail-open, and emits only an allowlisted provider-execution summary. OTLP spans are never internal trust evidence. |

### 4.3 Model routing / cost / observability

| System | Decision | Rationale |
|---|---|---|
| **litellm** | **OPTIONAL_PROVIDER** | **No official TS/Node SDK — Python SDK or an HTTP proxy.** But the proxy is Anthropic/OpenAI-compatible, so our existing `BifrostModelGateway` fetch pattern points at it unchanged. Adopt as *a* gateway implementation, never as the contract. Note the enterprise split (SSO etc. gated). |
| litellm `model_prices_and_context_window.json` | **INTEGRATE (data only)** | This checked-in JSON is the best available public pricing table and **fixes D2**. Vendor it as a versioned, digest-pinned data file — not a code dependency. Every derived number must carry `costBasis: ESTIMATE`, matching the existing discipline at `ports.ts:424-429`. |
| **RouteLLM** | **DESIGN_REFERENCE_ONLY** | Research artifact; needs trained routers/datasets; Python. MAF's own `strategy.ts` (`selectStrategy`, SHADOW/CANARY/PROMOTED/DEMOTED) is a better fit for our evidence model. Borrow the idea, not the code. |
| **langfuse** | **OPTIONAL_PROVIDER** | Useful self-hostable trace UI with a core/enterprise split. Since we emit OTLP anyway, Langfuse becomes just another OTLP destination. No coupling. |
| **promptfoo** | **ADAPT** | The right shape for Evolution-v2 offline replay/regression (§7). Config-driven, CI-friendly. Use it in the **evaluation harness**, never in the request path. |

### 4.4 Memory / knowledge

| System | Decision | Rationale |
|---|---|---|
| **TencentDB-Agent-Memory** | **REJECT** | Cloud-vendor-coupled; could not verify standalone usability, license, or TS support from primary sources. Introducing a PRC-cloud data dependency into a trust plane that stores source-derived facts is a compliance and sovereignty risk with no offsetting capability. Postgres already backs ProjectBrain. |
| **graphiti** | **DESIGN_REFERENCE_ONLY** | Its **bi-temporal fact invalidation** is directly relevant — MAF has exactly one staleness mechanism (`markStale(projectId, activeRevision)`, `ports.ts:263`). Steal the temporal model; do not add Neo4j/FalkorDB + a Python service. |

### 4.5 Evolution / prompts / skills

| System | Decision | Rationale |
|---|---|---|
| **dspy** | **DESIGN_REFERENCE_ONLY** | Python. Its *compile-a-program-against-a-metric* discipline is the right mental model for the Prompt Compiler (§5). Wrong runtime for us. |
| **GEPA** | **DESIGN_REFERENCE_ONLY** | Reflective prompt evolution — precisely the challenger-generation algorithm for §7. Reimplement the loop in TS against our own replay corpus; MAF's constraint is *provenance*, which GEPA does not model. |
| **agent-lightning** | **REJECT** | RL training loop, GPU-shaped. Out of scope for a control plane. |
| **Agent Skills (SKILL.md)** | **INTEGRATE (format)** | Markdown + YAML frontmatter with progressive disclosure — the body loads only when used. That is *Minimum Effective Context* expressed as a file format. Adopt the **format**; MAF selects skills by evidence. |
| **MCP prompts primitive** | **ADAPT** | Verified against spec 2025-06-18: `prompts/list` + `prompts/get`, explicitly **user-controlled** (not model-controlled), pagination, `listChanged` notifications. Correct transport for exposing MAF missions to native agents. Its user-controlled stance matches "MAF proposes, human authorizes." |
| **openclaw / hermes-agent / SWE-agent / mini-SWE-agent / Aider / OpenHands / LangGraph / MS Agent Framework / EvoAgentX / AG2** | **REJECT (all)** | Every one is an *agent framework* — they own planning, search, and the context loop. MAF's constitution says native Codex/Claude Code retain exactly those. Adopting any is a category error. Read them for adapter ergonomics only. |

### 4.6 Benchmarks / PM

| System | Decision | Rationale |
|---|---|---|
| **SWE-bench / SWE-bench Verified** | **ADAPT** | The credible external baseline. Python + Docker harness, so it stays an **offline evaluation lane**, never a runtime dependency. `benchmarks/` + `src/benchmark/runner.ts` already exist to host it. Directly addresses M15's `PARTIALLY_VERIFIED` external evidence. |
| **SWE-smith** | **OPTIONAL_PROVIDER** | Task generation for regression corpora. Useful for §7 replay; check task-license terms before shipping generated corpora. |
| **plane / openproject** | **DESIGN_REFERENCE_ONLY** | §9. MAF must not become Jira. Model the *handoff*, integrate later or never. |
| **awesome-llm-apps** (all named) | **DESIGN_REFERENCE_ONLY** | Demo-grade. `scope-creep-detector`, `commit-archaeologist`, `dependency-doctor`, `trust-gated-agent-team` are useful *concept* sources. None is production code. Zero integration. |

### Summary count

INTEGRATE 5 (osv-scanner, opengrep, pricing-data, SKILL.md format, +OTLP emit) ·
ADAPT 5 · OPTIONAL_PROVIDER 7 · DESIGN_REFERENCE_ONLY 12 · REJECT 15.

**Thin kernel, thick replaceable ecosystem.** Only 5 things actually ship.

---

## 5. Proposed canonical provider interfaces

All new contracts live in `src/domain/capability/`. **Rule: no third-party type crosses this line.**
Adapters translate SARIF/protobuf/JSON into MAF vocabulary at the boundary, and the MAF vocabulary is
the one that already exists (`ObligationStatus`, `AnalysisCoverage`, `EvidenceClaim`,
`EvidenceStrength`, `LanguageClass`).

### 5.1 The universal provider envelope

```ts
// src/domain/capability/provider.ts
export type ProviderExecution =
  | { outcome: "COMPLETED"; exitCode: number }
  | { outcome: "UNAVAILABLE"; detail: string }   // binary absent → NOT_CHECKED, never PASS
  | { outcome: "TIMED_OUT"; timeoutMs: number }
  | { outcome: "MALFORMED_OUTPUT"; detail: string }
  | { outcome: "REFUSED"; detail: string };

/** Every provider result is provenance-bound. No anonymous evidence, ever. */
export interface ProviderProvenance {
  capabilityId: CapabilityId;
  providerName: string;        // "osv-scanner" — a LABEL, never a branch condition
  providerVersion: string;     // captured from the tool itself, not configured
  rulesetDigest?: string;      // sha256 of the ruleset actually used
  invokedAt: string;
  durationMs: number;
  candidateId: string;
  diffDigest: string;
  baseRevision: string;
}

export interface CapabilityFinding {
  target: EstablishmentTarget;
  claim: EvidenceClaim;
  strength: EvidenceStrength;
  file?: string;
  line?: number;
  ruleId: string;
  message: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface CapabilityResult {
  provenance: ProviderProvenance;
  execution: ProviderExecution;
  findings: CapabilityFinding[];
  /** Per-language-class coverage the provider ACTUALLY achieved on this candidate. */
  coverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
  /** Separate, and never defaulted to `coverage`. Silence is not absence. */
  negativeCoverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
  /** Files the provider provably read. Empty ⇒ no absence claim is admissible. */
  analyzedFiles: string[];
}

export interface CapabilityProvider {
  readonly capabilityId: CapabilityId;
  readonly name: string;
  /** Probe: is the tool actually present and runnable? Never throws. */
  probe(): Promise<{ available: boolean; version: string | null; detail: string }>;
  analyze(input: CapabilityInput): Promise<CapabilityResult>;
}

export interface CapabilityInput {
  sandbox: Sandbox;
  diff: SandboxDiff;
  candidateId: string;
  diffDigest: string;
  signal?: AbortSignal;
}
```

### 5.2 The registry (this is what kills `if (provider === "joern")`)

```ts
// src/application/capability-registry.ts
export class CapabilityRegistry {
  private readonly byCapability = new Map<CapabilityId, CapabilityProvider[]>();
  register(p: CapabilityProvider): void;
  /** Providers that PROBED available. Absence is reported, never silently skipped. */
  resolve(id: CapabilityId): Promise<CapabilityProvider[]>;
}
```

The kernel asks for a **capability**, never a vendor. `run-service.ts` gains **no** provider branch.
The only place a provider name appears is its own adapter file and the telemetry label.

### 5.3 Fold rule — the trust-preserving translation

```
execution.outcome !== COMPLETED           → NOT_CHECKED  (+ detail)
COMPLETED, findings > 0                   → FAIL | WARN by severity, claim POSITIVE_FINDING
COMPLETED, 0 findings, negCov FULL        → PASS         (bounded to that language class only)
COMPLETED, 0 findings, negCov PARTIAL     → UNKNOWN
COMPLETED, 0 findings, negCov UNSUPPORTED → UNSUPPORTED
candidate has a language class not in coverage → UNSUPPORTED for that class
```

**A provider can never return PASS for a language class it did not read.** This single table is what
makes `External Scanner CLEAN != candidate secure` mechanically true.

### 5.4 Concrete adapters (Phase 2–3)

| Capability | Provider | Boundary translation |
|---|---|---|
| `SECURITY.DEPENDENCY_VULNERABILITY_SCAN` *(new)* | osv-scanner | Strict v2.5.1 JSON → exact findings over explicit changed `package-lock.json`; unsupported input/exits stay non-results and all negative coverage is UNSUPPORTED. |
| `SECURITY.SEMANTIC_FLOW_SCAN` | opengrep | Strict v1.27.1 JSON → exact findings from digest-matched MAF-owned rules/manifest; every negative-coverage class is UNSUPPORTED. |
| `SECURITY.CREDENTIAL_LITERAL_SCAN` | gitleaks *(legacy future comparator; not integrated)* | If ever piloted, SARIF → findings and `negativeCoverage: UNSUPPORTED` **always** — entropy/regex silence is never absence proof. Preserves `capability-adequacy.ts` finding H1. |
| `CODEGRAPH.SYMBOL_INDEX` *(new)* | scip-typescript | protobuf → navigation index (§6). Not an assurance capability. |
| `SECURITY.INTERPROCEDURAL_FLOW` *(new)* | joern *(opt-in)* | CPG query → findings; the only capability permitted `negativeCoverage: PARTIAL` cross-file. |

---

## 6. Context Intelligence architecture ("navigate, don't load")

Replaces D4. Today `GuidedContextBuilder` emits modules × 8 files + ≤60 symbols + ≤30 facts as flat
prose with a `length/4` token estimate. That is a dump whose size grows with the project.

**Invariant: `|context| = f(mission complexity)`, NOT `f(project size)` and NOT `f(memory size)`.**

```
L0 CONSTITUTION      ~200 tok   fixed    Non-negotiables. Never varies. Never evicted.
L1 ORIENTATION       ~500 tok   O(1)     Module ROOTS + entry points + verification command.
                                          Cardinality-capped: N modules → still ~500 tok.
L2 MISSION WORKING   ~2k tok    O(mission) Mission Contract, obligations, selected skills,
                                          the specific files risk analysis implicated.
L3 HOT PAGES         on demand  pull     Symbol/evidence pages the agent REQUESTS by handle.
L4 COLD STATE        0 tok      handles  ProjectBrain + CodeGraph + history. Addressable,
                                          never resident. Referenced as `maf://` URIs.
```

L0–L2 are pushed (bounded). L3 is pulled. L4 is never pushed at all.

### The critical mechanism: handles, not content

```ts
export interface ContextHandle {
  uri: string;          // maf://symbol/AuthService#validate@a1b2c3
  kind: "SYMBOL" | "MODULE" | "EVIDENCE" | "CAPSULE" | "HISTORY";
  summary: string;      // ≤120 chars — enough to decide whether to fetch
  revision: string;
  digest: string;
}
```

The agent receives *handles*. It resolves what it needs through its own native search/tools — which
is exactly what the constitution demands: native agents keep their own context loop. MAF supplies
**navigation, not payload**.

`ContextBuildResult` gains `layers`, `handles[]`, and a real tokenizer-backed `tokenEstimate`
(`length/4` is wrong for code, which is dense in punctuation).

Memory growth ⇒ more L4 handles ⇒ **zero context growth**. Invariant satisfied by construction.

---

## 7. Compiled Project Knowledge & Evolution v2

### 7.1 Capsules

```ts
export interface KnowledgeCapsule {
  id: string; projectId: string; kind: "MODULE" | "INTERFACE" | "HISTORY";
  statement: string;                 // compressed claim
  revision: string;                  // binding revision
  sourceDigests: Record<string,string>; // file → sha256 it was compiled from
  coverage: AnalysisCoverage;
  confidence: "OBSERVED" | "DERIVED" | "INFERRED";
  evidenceRefs: string[];
  stalenessTriggers: string[];       // globs that invalidate this capsule
  compiledAt: string;
}
```

Today staleness is revision-global (`markStale(projectId, activeRevision)`). A capsule about
`src/web/` should **not** be invalidated by a change to `src/domain/`. `stalenessTriggers` +
`sourceDigests` make invalidation *path-precise* — this is the graphiti idea, implemented in Postgres
without Neo4j.

### 7.2 Evolution v2 lifecycle

`strategy.ts` already has `SHADOW | CANARY | PROMOTED | DEMOTED` and
`allocateStrategyCanaryOrdinal` (atomic, caller cannot choose its slot — good). Extend the *scope* of
what evolves: context routing, skill selection, prompts, model choice, strategy, assurance
scheduling.

```
experience → challenger → replay → regression → frozen hidden eval → shadow → promotion
```

**Production policy never mutates online.** Enforced structurally:

```ts
export interface PolicyBundle {
  readonly id: string;
  readonly digest: string;
  readonly frozenAt: string;
  readonly evalResults: { corpusDigest: string; passRate: number; sampleSize: number };
}
```

Loaded immutably at startup. A challenger is a *different bundle id*, never a mutation. The frozen
hidden eval corpus must be **digest-pinned and never used for challenger generation** — otherwise
it is a training set, not a holdout. GEPA supplies the challenger-generation loop; promotfoo the
replay harness; both offline.

---

## 8. Strategy / model / cost architecture

The brief asserts `complexity != risk != coupling`. **Repository evidence agrees and already
implements it** — `risk.ts` `RiskVector` carries independent dimensions (`CodeCoupling`,
`ArchitectureSensitivity`, `BlastRadius`, `SecuritySensitivity`, `PerformanceSensitivity`,
`DataConsistencyRisk`, `NetworkBoundaryChanges`, `OperationalSensitivity`, `DebtRisk`), and
`assurance.ts:102-189` reads them separately. No change needed. **Do not "fix" what is already
correct.**

The real work is D2/D3:

```ts
export interface CostModel {
  readonly sourceDigest: string;                 // pinned pricing-table digest
  readonly sourceUpdatedAt: string;
  price(provider: string, model: string): ModelPrice | null;   // null = UNKNOWN, never 0
}
export interface ModelSelection {
  model: string; provider: string;
  rationale: string;
  basis: "POLICY_DEFAULT" | "STRATEGY_LEARNED" | "OPERATOR_PINNED" | "FALLBACK";
}
```

`null` pricing ⇒ `costBasis: UNKNOWN` propagates to telemetry, exactly as `ports.ts:424-429` already
demands for agent-reported cost. **A missing price is never zero.** Model routing becomes a
`ModelSelector` port; today's single-gateway behaviour is `POLICY_DEFAULT` and remains the default.

---

## 9. PM / UI future architecture

**MAF must not become Jira.** The domain boundary: MAF owns *engineering judgment and evidence*; a
PM tool owns *human work coordination*. One direction, one contract:

```ts
export interface WorkItemHandoff {          // MAF → PM, evidence-bound, immutable
  runId: string; candidateId: string; trustState: TrustState;
  unresolvedObligations: Array<{ id: string; status: ObligationStatus; justification: string }>;
  externalRef?: { provider: string; id: string; url: string };
}
```

This mirrors the existing `DeliveryHandoff` (M13) exactly — reuse that pattern, do not invent a
second one. Plane/OpenProject remain DESIGN_REFERENCE_ONLY.

**Engineering Control Center** = a read-model over existing evidence (health ledger M11, strategy
observations M12, obligations, trust states). It must be **derived**, never authoritative:
*Generated UI != Authority*. Fix D8 by generating `src/web/types.ts` from domain types so the UI can
never drift into claiming trust the kernel did not grant.

---

## 10. Dependency & licensing risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Semgrep LGPL-2.1 + proprietary registry rules** | HIGH | REJECTED as primary. Opengrep (LGPL-2.1, consortium-backed) instead. **Never vendor Semgrep Registry rules** — they are separately licensed. |
| **gitleaks sunset** ("security patches only") | MEDIUM | Classified **LEGACY_OPTIONAL** and not integrated. The contract stays tool-agnostic, so any future comparator remains an adapter-only decision. |
| **betterleaks rapid evolution** | MEDIUM | MIT/tag/maintenance are now verified, but it remains a non-integrated CHALLENGER pending a pinned, validation-disabled shadow corpus. |
| **Joern JDK21/Scala** | MEDIUM | Opt-in only; core MAF must run with zero JVM. |
| LGPL-2.1 (opengrep) | LOW | Keep the CLI as a separately installed process, do not vendor its source, preserve required notices for any redistribution, and obtain legal review before changing the distribution model. |
| E2B / Temporal Cloud vendor lock | MEDIUM | Both behind ports; neither default. |
| **litellm pricing JSON drift** | MEDIUM | Digest-pinned, staleness-dated, surfaced as UNKNOWN when stale. Never silently wrong. |
| SWE-bench task licensing | LOW | Offline eval lane only; never redistributed. |
| **Tencent cloud data sovereignty** | HIGH | REJECTED. |
| Supply chain of new binaries | MEDIUM | Pin exact versions and verify operator-approved release artifacts/checksums before deployment; record the evidence independently of a successful version probe. |

---

## 11. Exact implementation sequence

**Phase 0 — Baseline (blocking, no features).** Land or abandon the 88-file delta. Close M15 external
evidence. Tag `v1-baseline`. *Nothing below may start on a dirty tree.*

**Phase 1 — Provider foundation (no vendors).** Create `src/domain/capability/`: `provider.ts`,
`fold.ts`. Create `src/application/capability-registry.ts`. Wire an **empty** registry into
`RunServiceDependencies` as `capabilities?: CapabilityRegistry`. Ship with zero providers — behaviour
must be byte-identical. This is the phase Session 2 implements.

**Phase 2 — First real provider (osv-scanner): implemented in Session 3.** Adds a capability MAF
genuinely lacked. Only bound positive findings can add an exact material obligation; clean output
cannot promote because dependency scope does not align with the source-language coverage axis.

**Phase 3 — opengrep: implemented in Session 3** as `SECURITY.SEMANTIC_FLOW_SCAN`. It runs
**alongside** the existing local scanner when explicitly configured. Operator-owned rules are
digest-bound, positive-only, and feed exact obligations; the fold never upgrades on silence.

**Phase 4 — Context OS.** L0–L4 + handles + real tokenizer. Highest product value, but only after the
provider seam is proven, because L3/L4 depend on capability-produced evidence.

**Phase 5 — Cost/model authority.** Pinned pricing table, `ModelSelector`, kill the `null` stub.

**Phase 6 — Compiled knowledge + capsule staleness.**

**Phase 7 — Evolution v2** (offline lane; frozen holdout).

**Phase 8 — SWE-bench external baseline.** Closes M15's `PARTIALLY_VERIFIED`.

**Phase 9 — Control Center read-model + generated UI types.**

---

## 12. Files touched per phase

| Phase | Create | Modify |
|---|---|---|
| 1 | `domain/capability/{provider,fold}.ts`, `application/capability-registry.ts` | `domain/ports.ts` (export), `application/run-service.ts` (**one optional dep only**), `server/app.ts` (wire empty) |
| 2 | `infrastructure/providers/osv-scanner-adapter.ts` | `domain/assurance-obligation.ts` (+1 CapabilityId), `capability-adequacy.ts` (+matrix row), `server/app.ts` |
| 3 | `infrastructure/providers/opengrep-adapter.ts` | same three |
| 4 | `domain/context/{layers,handles}.ts`, `application/context-compiler.ts` | `application/context-builder.ts`, `domain/ports.ts` |
| 5 | `domain/cost/price-table.ts`, `infrastructure/pricing/*.json` | `infrastructure/model-gateway.ts`, `domain/budget.ts` |
| 6 | `domain/knowledge/capsule.ts` | `infrastructure/project-brain.ts`, +migration 011 |
| 7 | `domain/evolution/policy-bundle.ts` | `domain/strategy.ts` |
| 8 | `benchmarks/swebench/*` | `src/benchmark/runner.ts` |
| 9 | `scripts/generate-web-types.ts` | `src/web/types.ts` (generated) |

## 13. Modules that must NOT be touched

**Hard freeze** — 7 hardening passes and adversarial tests defend these; changing them silently
re-opens closed trust findings:

- `domain/assurance.ts` — the plan rule table (extend the *registry*, not the planner)
- `domain/capability-adequacy.ts` **logic** — add matrix *rows* only, never change comparison rules
- `domain/risk.ts` — dimensions are correct and independent
- `domain/verification-attribution.ts`, `domain/policy-enforcement.ts`, `domain/circuit-breaker.ts`
- `domain/delivery.ts`, `domain/recovery.ts`, `domain/production-feedback.ts`
- `infrastructure/postgres/store.ts` digest/rebinding logic
- migrations 001–010 (**append only**)
- `tests/trust-kernel.test.ts`, `trust-composition.test.ts`, `negative-authority-conservation.test.ts`,
  `promotion-authority-adversarial*.test.ts`, `*-conservation.test.ts` — **if a provider change makes
  one of these fail, the provider is wrong, not the test.**

Also do not touch: `run-service.ts` beyond adding one optional dependency (D1 refactor is a separate,
later, isolated program); the 88 dirty files owned by the concurrent session.

---

## 14. Test / invariant plan

New invariant tests (Phase 1, written **before** any adapter):

1. **I1 unavailable-is-not-pass** — provider `UNAVAILABLE` ⇒ `NOT_CHECKED`; never PASS.
2. **I2 silence-is-not-absence** — 0 findings + `negativeCoverage: UNSUPPORTED` ⇒ UNSUPPORTED.
3. **I3 coverage-bounded-pass** — PASS never spans a language class absent from `coverage`.
4. **I4 no-vendor-leak** — *static test*: grep `src/domain` + `src/application` for vendor names;
   fail on any hit. Mechanically enforces the ACL.
5. **I5 provenance-completeness** — every finding traces to `capabilityId` + `providerVersion` +
   `diffDigest`; unbound evidence is rejected.
6. **I6 empty-registry-identity** — with zero providers, every existing test passes unchanged.
7. **I7 malformed-output** — corrupt SARIF/JSON ⇒ `MALFORMED_OUTPUT` ⇒ NOT_CHECKED, never a crash and
   never a pass.
8. **I8 timeout-is-not-failure** — provider timeout is a bounded-execution outcome (mirrors the
   existing `verifier.ts` termination discipline).
9. **I9 context-bound** — L0+L1+L2 token count stays within budget as project file count scales 10×.
10. **I10 memory-does-not-grow-context** — 10× ProjectBrain records ⇒ context tokens unchanged.
11. **I11 policy-immutability** — no code path mutates a loaded `PolicyBundle`.
12. **I12 price-unknown-not-zero** — missing price ⇒ UNKNOWN propagated, never 0.

---

## 15. Risks of this architecture

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Provider sprawl** — the registry makes adding providers easy, and easy things multiply | Hard cap: a provider ships only with a `capability-adequacy` matrix row and adversarial tests. 5 INTEGRATE, no more, this cycle. |
| R2 | **External tools become a trust laundromat** — an authoritative-looking SARIF upgrades trust it did not earn | The §5.3 fold + I1/I2/I3. Coverage is claimed by the *adapter author*, reviewed like domain code. |
| R3 | **`run-service.ts` D1 worsens** | Phase 1 adds exactly one optional dep. D1 refactor is separately scheduled. |
| R4 | **Context OS regression** — handles could underserve the agent vs today's dump | Phase 4 runs behind a flag with A/B on verified-success-per-cost before default flip. |
| R5 | **Evolution v2 overfits the holdout** | Corpus digest-pinned; challenger generation may never read it; rotate on promotion. |
| R6 | **Operational weight creep** — E2B/Joern/Temporal "just for one feature" | All OPTIONAL_PROVIDER. **Core MAF must run with only Node + git + Postgres.** CI test asserts this. |
| R7 | **Adapter rot** — upstream flags/schemas drift | Pin versions; `probe()` captures real version; version mismatch ⇒ NOT_CHECKED, not a silent wrong parse. |
| R8 | **Concurrent-session conflict** | Phase 0 gate. |

---

## 16. Explicit disagreements with the brief

1. **"Design the next evolution" ⇒ Phase 0 first.** M15 external evidence is `PARTIALLY_VERIFIED` and
   88 files are uncommitted. Building on that is malpractice. *(evidence: git status; ledger:51)*
2. **Temporal: REJECT, not integrate.** MAF already has durable state, capsules, and bounded retry in
   Postgres. Temporal adds a cluster to operate and determinism constraints on workflow code, in
   exchange for machinery MAF already owns and tests. Violates "operationally small."
3. **Semgrep: REJECT in favour of its fork.** The brief lists both semgrep and opengrep. Upstream's
   own docs say CE is single-function/single-file and "will miss many true positives"; the useful
   analysis and the 20k rules are commercial. Opengrep is the strictly better licensed choice.
4. **gitleaks is not a safe primary.** Upstream declares itself feature-complete/security-patches-only.
   The brief implies it as a mainstay; evidence says design the contract vendor-neutrally.
5. **betterleaks remains a challenger, not a canonical provider.** Session 3 verified the MIT
   license and current `v1.8.1` release from primary sources, but its rapidly evolving rules and
   optional live credential validation require a pinned, validation-disabled shadow pilot first.
6. **Tencent memory: REJECT** on sovereignty + unverifiability, not merely on fit.
7. **"complexity != risk != coupling" needs no work.** `risk.ts` already models these as independent
   dimensions and `assurance.ts` already reads them separately. The brief implies a gap that the code
   disproves. **Do not refactor a correct module to satisfy a restated principle.**
8. **The brief's biggest omission: there is no anti-corruption debt to repay.** Grep proves zero
   vendor names in `src/`. The framing "do not produce architecture where `if provider == …`" implies
   remediation; the actual task is *preserving* an already-clean boundary while adding the first real
   external dependencies. That reframes Phase 1 from refactor to **greenfield contract**.

---

# SESSION 2 IMPLEMENTATION CONTRACT

**Scope: Phase 1 only — the provider foundation. Zero vendor adapters. Zero behaviour change.**

### Preconditions (verify before writing code)
1. `git status --porcelain` is **empty**. If not, STOP and report.
2. `npm run validate` passes on the baseline.
3. Record the baseline commit SHA in the ledger.

### Deliverables

**D1 — `src/domain/capability/provider.ts`** (new, pure, no I/O)
Export verbatim from §5.1: `ProviderExecution`, `ProviderProvenance`, `CapabilityFinding`,
`CapabilityResult`, `CapabilityProvider`, `CapabilityInput`.
Import `AnalysisCoverage` from `../assurance`; `EvidenceClaim`/`EvidenceStrength`/`LanguageClass`/
`EstablishmentTarget` from `../capability-adequacy`; `CapabilityId` from `../assurance-obligation`;
`Sandbox`/`SandboxDiff` from `../ports`. **No new npm dependency. No vendor identifier anywhere.**

**D2 — `src/domain/capability/fold.ts`** (new, pure)
```ts
export const foldCapabilityResult = (
  result: CapabilityResult,
  candidateLanguageClasses: LanguageClass[],
): { status: ObligationStatus; coverage: AnalysisCoverage; justification: string };
```
Implement §5.3 **exactly**. Every branch sets a non-empty `justification`. Reuse
`meetsStrength` from `capability-adequacy.ts`; do not reimplement it.

**D3 — `src/application/capability-registry.ts`** (new)
`register()` / `resolve()` per §5.2. `resolve()` calls `probe()` and **caches per process**.
`probe()` must never throw — a throwing probe is `available: false`. Providers are ordered by
registration. No provider-name branching.

**D4 — wiring**
- `src/domain/ports.ts`: re-export the new capability types. **Change nothing else.**
- `src/application/run-service.ts`: add `capabilities?: CapabilityRegistry` to
  `RunServiceDependencies`. **That is the only permitted edit to this file.** Do not call it yet.
- `src/server/app.ts`: construct an empty `CapabilityRegistry` and pass it.

**D5 — tests** `tests/capability-provider.test.ts` (new): I1, I2, I3, I5, I6, I7, I8 from §14 using
in-test fake providers. `tests/no-vendor-leak.test.ts` (new): I4 — grep `src/domain` and
`src/application` for `semgrep|opengrep|gitleaks|osv|joern|scip|trivy|snyk|codeql|temporal|litellm|
langfuse|e2b|dagger`; **fail on any match.**

### Acceptance
- `npm run validate` green.
- **Every pre-existing test passes unmodified.** If any trust test fails, the implementation is
  wrong — do not edit the test.
- Diff touches only: 4 new files, 2 new test files, and ≤10 lines across `ports.ts`,
  `run-service.ts`, `app.ts`.

### Forbidden in Session 2
Installing any dependency · writing any vendor adapter · modifying frozen modules (§13) · changing
`AnalysisCoverage`/`ObligationStatus`/`CapabilityId` **semantics** (additive `CapabilityId` members
are Phase 2, not Phase 1) · refactoring `run-service.ts` · touching migrations · committing or
pushing without explicit instruction.

### Definition of done
The registry exists, is fully tested, is wired, and **holds zero providers** — so MAF behaves exactly
as it did at baseline, and Phase 2 can add osv-scanner by writing one adapter file plus one matrix
row, touching no kernel logic.

---

# SESSION 7 IMPLEMENTATION RECORD

Status: IMPLEMENTED; final validation evidence is recorded in the Session 7 handoff.

Session 7 builds execution intelligence above the completed Context OS Phase 1B. It does not alter
the assurance obligation fold, PASS/UNKNOWN meanings, candidate/evidence binding, trust ladder, or
merge eligibility.

## Delivered boundaries

1. `domain/mission.ts` + `application/mission-compiler.ts`: deterministic Mission Contract with
   explicit UNKNOWN/UNSPECIFIED semantics. Authority is MAF policy, never prompt prose.
2. `domain/prompt.ts` + `application/prompt-compiler.ts`: structured/versioned Prompt Artifact whose
   resident project material is exactly the current Context Working Set. Stable and variable
   sections remain separate.
3. `domain/agent-skill.ts` + `infrastructure/agent-skill-registry.ts`: open Agent Skills packaging,
   progressive disclosure, whole-package version digest, external MAF binding, lifecycle and
   authority intersection, bounded resource loading, no automatic script execution.
4. `domain/model-intelligence.ts`: canonical model identity and explicit exact/estimated/native-
   subscription/unknown monetary semantics, plus orchestration-aware accumulation.
5. `domain/execution-intelligence.ts`: structured decision inputs with factual provenance,
   minimum-intervention result, optional non-default advisor/worker representation, and assurance
   conservation across cost/provider decisions.
6. `domain/evolution.ts`: generic evaluation records, frozen suite lineage, immutable constitution
   binding, and MAF-owned promotion. Evaluations cannot project trust.
7. `RunService`: compiles/persists Mission identity, records governed Skill selection, and compiles
   a Prompt Artifact for every native attempt before adapter execution. Prompt events persist only
   identities/digests, not raw prompt/Skill/context content.
8. `ModelGateway`: optional provider-neutral pricing catalog; missing pricing is explicit UNKNOWN.

## Explicit deferrals

- No optimizer, online mutation, marketplace, model router, advisor/worker orchestrator, external
  evaluation deployment, pricing dataset, or proxy gateway was added.
- The new strategy decision remains advisory and does not automatically route `RunService.create()`.
- Skill certification policy remains an injected MAF binding; the reference server discovers
  configured roots but has no implicit production certification source.
- Existing numeric run/telemetry cost fields remain for compatibility; canonical cost records are
  the Session 7 seam for later independently metered execution.

## Validation evidence

- Pre-session `npm run validate`: PASS — 69 test files, 986 tests; server/UI builds, Compose and
  smoke passed. Existing lint result: 13 warnings and 6 informational suggestions.
- Focused Session 7 tests: PASS — 4 files, 16 tests.
- Context OS + capability/provider + trust/evidence authority-conservation + RunService regressions:
  PASS — 26 files, 464 tests.
- Final `npm run validate`: PASS — 73 test files, 1,002 tests; 4 files/8 tests skipped only where
  opt-in infrastructure was absent; server/UI builds, Compose validation and smoke passed.
- Final lint retained the same 13 warnings and 6 informational suggestions as the baseline; no
  Session 7 file emitted a diagnostic.
