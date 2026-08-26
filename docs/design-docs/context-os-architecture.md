# Context OS — Session 4 Architecture (implementation-ready for Session 5)

Status: architecture only. No Context OS code written in Session 4.
Evidence base: current working tree (dirty overlay authoritative), branch `adaptive-harness/runtime-signals-v0.1`.

---

## A. Actual current Context architecture and call flow

The real flow is much smaller than historical planning text implies. `src/application/context-builder.ts` is **93 lines**.

Authoritative call sequence (`src/application/run-service.ts:1051–1122`):

1. `projectBrain.markStale(task.repositoryPath, task.revision)` — run-service.ts:1051
2. `repositoryIndex.index(sandbox.path, revision)` → **cheap full pass**, paths + path-derived ownership only, no content read (ports.ts:234–236) — run-service.ts:1053
3. `contextBuilder.build({snapshot: cheapSnapshot})` → **scope selection only** (`initialFiles`) — run-service.ts:1058
4. `repositoryIndex.indexScope(..., scope.initialFiles)` → **bounded parse of just those files**, digest-cached (ports.ts:237–248) — run-service.ts:1064
5. `contextBuilder.build({snapshot: enrichedSnapshot})` → re-render with real symbols — run-service.ts:1071
6. `ContextState { current, mode, snapshot, projectId, baselineStructuralHealth }` — run-service.ts:1077
7. `ContextBuilt` event with `tokenEstimate`, `initialFiles`, `filesTruncated`, `scopeTruncated` — run-service.ts:1084

In-run growth: `growGraph` (fuzzy-resolves agent-claimed paths against known files, run-service.ts:2983–2999) and `growGraphTrusted` (exact paths, run-service.ts:3006–3016), both funnelling into `applyGraphGrowth` → `indexScope` (run-service.ts:3018–3050). Failure is non-fatal: `ScopeIndexFailed` event, returns false (run-service.ts:3035–3042).

Rebuild: `refreshContext` (run-service.ts:2146–2176) rebuilds **only when `contextState.mode !== run.effectiveMode`** (early return at 2152). Called at run-service.ts:1127 and 1385 (before repair sessions).

**Finding A1 — the two-phase select-then-parse pager already exists.** MAF is not starting from a flat dump. `index` → `build(select)` → `indexScope(selected)` → `build(render)` is already demand paging with a digest cache. Session 5 must **name and instrument** this, not replace it.

**Finding A2 — the ledger substrate already exists.** `runtime-signal-collector.ts:404` emits `deterministic("contextExpansion", state.expandedFiles.size, "observed-repository-files")` — a deterministic, observed count of expanded files, already consumed by `mode-controller.ts:80,102,112`. This is the seed of the Context Ledger, and it is already observation-derived rather than model-narrated.

---

## B. Current GuidedContextBuilder debt

The mandate's premise ("flat context dump growing with project state") is **partly inaccurate for the prompt text and accurate for the state object**. Precisely:

**B1 — the rendered text is already bounded, but by arbitrary literals.** context-builder.ts:
- modules: `slice(0, mode === "STRICT" ? 2 : 4)` (line 58–59)
- files per module: `files.slice(0, 8)` (line 60, 63)
- symbols: `slice(0, STRICT ? 20 : 60)` (line 67)
- facts: `slice(0, 30)` (line 71)

These are hardcoded magic numbers, not a budget. They are **caps, not policy**: there is no notion of "smallest sufficient", no cost input, no mission-risk input, and no record of what was cut. A truncation at `slice(0,30)` is silent — unlike `filesTruncated`/`scopeTruncated`, which are explicitly non-silent by design (ports.ts:212–213, 226–227). **This asymmetry is the single clearest debt: the repository index refuses silent truncation, the context builder performs it.**

**B2 — `tokenEstimate` is `text.length / 4`** (context-builder.ts:24, 88). A character heuristic reported as a number into `ContextBuilt` telemetry. Per §16, this must be labelled as an estimate, never as measured tokens.

**B3 — relevance ranking is lexical substring matching only.** Task prompt is split on `/[^a-z0-9_$-]+/u`, terms ≥3 chars, scored by `name.includes(term) ? 4 : 0` plus per-file substring hits (context-builder.ts:35–53). No symbol graph, no changed-file signal, no dependency distance, no test linkage — despite `snapshot.relations` being available. This is the true relevance debt.

**B4 — fallback selects arbitrary modules.** When no module scores > 0, it takes `rankedModules.slice(0, 2|4)` (line 55–59) — the first modules in tie-broken alphabetical order. This is *not* "no relevant context found"; it is unlabelled noise presented in the same section as ranked results.

**B5 — `evidenceIds` is unbounded and unfiltered.** Line 87: `knowledge.flatMap(r => r.evidenceIds)` over **all** returned knowledge, while only 30 facts were rendered (line 71). It deliberately does not use the 30-record `facts` slice. This is the one field in the build with no cap, and it flows into the durable `ContextBuilt` event (run-service.ts:1086).

**Correction:** this is a **latent** defect, not an active one. Because no production code calls `brain.add` (§C0), `knowledge` is always `[]` and `evidenceIds` is always `[]` today. It is a real design flaw that would bite **the moment the brain write path is wired** — which makes it a precondition to fix, not a live leak. The genuine present-day scaling cost is the ranking scan (B3a below), not this.

**B3a — the unbounded work is upstream of the text.** `Object.entries(request.snapshot.moduleMap)` (line 41) scores **every module in the repository** against every task term and then sorts the full list (line 53) — O(modules × terms × files), with `moduleMap` covering every tracked file up to `MAX_TRACKED_FILES = 100_000` (project-brain.ts:155). Line 65 likewise filters `snapshot.symbols` in full before slicing. This runs on **four builds per run** (run-service.ts:1058, 1071, 2156, 2163), because each context change does a throwaway "scope" build whose `text` and `brain.list()` are discarded and only `initialFiles` is used. **This — not prompt size — is the real project-size-coupled cost in the current context path.**

**B6 — the whole `RepositorySnapshot` is carried in `ContextState` and attached to observations.** `RuntimeObservation.INITIAL_CONTEXT.repository: RepositorySnapshot` (ports.ts:306) and `AGENT_EVENT.repository?` (ports.ts:320). Snapshot grows with repository size (`files: string[]`, `symbols`, `relations`, `evidence`). It does not enter the prompt, but it does enter persisted signal snapshots. **Memory growth → storage growth is acceptable; the invariant to protect is memory growth → prompt growth.**

**B7 — SOLO_NATIVE is already correct and must be preserved.** context-builder.ts:15–28 returns three lines and empty `initialFiles`. This is already the "minimum effective context" endpoint the mandate asks for; §28's requirement is satisfied here today.

---

## C. Current ProjectBrain role and limitations

**C0 — THE DOMINANT FINDING: the knowledge path is inert in production.**

`grep -rn "projectBrain\.add\|brain\.add" src/` returns **zero production callers**; the only callers are `tests/project-brain.test.ts:20,35`. Therefore, on the real server:

- `brain.list()` always returns `[]`
- `context-builder.ts:83` **always** renders the literal `"No verified facts recorded for this revision."`
- `ContextBuildResult.evidenceIds` is **always** `[]`

Compounding this, the only implementation is `InMemoryProjectBrain` (project-brain.ts:16–17) — a process-local `Map`, wired at `server/app.ts:338`. There is **no Postgres brain**: `grep -rln "knowledge|brain" migrations/ src/infrastructure/postgres/` returns nothing, even though runs/telemetry do get Postgres when `DATABASE_URL` is set (app.ts:332–337). **Knowledge cannot survive a process restart.**

This supersedes my earlier framing. C1–C4 below describe defects in machinery that **currently protects data that never exists**. The revision-global `markStale` sweep is not today's binding constraint — *nothing is ever written to be invalidated*. Storage durability and a write path are the actual blockers, and they are upstream of every capsule refinement.

**Consequence for Session 5 (see the amended contract):** shipping capsule provenance and digest-triggered staleness against a non-durable, never-written store would be building the roof before the foundation. The ordering is corrected in §Y/Phase 1.

Port: ports.ts:275–279 — `add`, `list(projectId, revision, kinds?)`, `markStale(projectId, activeRevision)`.
Record: ports.ts:264–273 — `{id, projectId, revision, kind, statement, evidenceIds, status, createdAt}`.
`KnowledgeKind = "FACT" | "INFERENCE" | "EVIDENCE" | "DECISION"` (ports.ts:262); `KnowledgeStatus = "ACTIVE" | "STALE"` (ports.ts:261).

**C1 — invalidation is revision-global.** project-brain.ts:42–50: any ACTIVE record whose `revision !== activeRevision` becomes STALE. This is precisely the over-invalidation §10 warns against — a README commit invalidates every fact about every module. It is *safe* (conservative) but destroys the N+1 orientation property: after any commit, compiled knowledge is worthless, so cost-per-task never amortises.

**C2 — `list()` filters `status === "ACTIVE"` and `revision === revision`** (project-brain.ts:35–36). Combined with C1, `list` returns only knowledge written at the exact current revision. **Compiled project knowledge therefore currently has a useful lifetime of one commit.** This, not prompt size, is the dominant reason MAF cannot amortise project understanding today.

**C3 — no provenance beyond `evidenceIds`.** No source digest, no scope, no coverage, no confidence, no staleness trigger, no verification state. `kind` distinguishes FACT from INFERENCE, which is the *right seed* for §9's "LLM summary != verified project truth" — but nothing enforces it: a record's `kind` is set by whoever calls `add`, and `context-builder.ts:70` renders `FACT` and `DECISION` **identically prefixed and undifferentiated in authority** into "Verified knowledge:". An INFERENCE is excluded, which is correct; but a FACT written by a model is presented as verified.

**C4 — only two states.** `ACTIVE | STALE`. §10 requires `CURRENT | STALE | UNKNOWN | CONFLICTED`. There is no representation for "two records disagree" or "we do not know if this still holds".

---

## D. Session-3 provider/trust coupling review

Answering the three mandated questions. **No material regression found; one deferred axis is documented in-code as a known bound.**

**D1 — Was the authority boundary preserved? Yes.** `capability-adequacy.ts` keeps coverage as a property of `(capability, concern, claim-direction, language-class)` — `CapabilityEstablishment.coverage: Partial<Record<LanguageClass, AnalysisCoverage>>` plus a **separate** `negativeCoverage` (capability-adequacy.ts:195, 202). The header comments record why: finding C1 (PARTIAL treated as proof) and C2 (coverage was language-global, so a credential-literal scanner claimed env-secret authority). Both are fixed by construction, not by prose.

The boundary is enforced at `assurance-obligation.ts:642` — *"positive detection authority is not negative-absence authority"* — and at 647, rejecting unscoped absence claims: *"COMPLETE plus candidate/digest binding is not magical authority over previously unaccounted scope"*. Providers **propose**; the obligation layer **decides**. That is the correct direction.

**D2 — Did external-capability concepts leak into generic trust semantics? Marginally, and defensibly.** `quality.ts` gained `QualityCheckResult.coverage?: AnalysisCoverage` (quality.ts diff, `+coverage?: AnalysisCoverage`). This is a generic type carrying a coverage enum. The mitigation is explicit and correct: the field is **optional**, and the doc comment states absence means "the dimension has no coverage notion". Crucially, `PASS`+`UNSUPPORTED` and `PASS`+`FULL` are kept mechanically distinguishable (trust invariant E). That is a genuine strengthening, not a leak.

The genuine smell: `deriveSecurity` in quality.ts now directly imports and calls `deriveSemanticSensitivity`, `discoverConcerns`, `deriveConcernEvidence`, `deriveAssuranceQuestionEvidence`, `deriveDiscoveryAdequacyEvidence`. A generic quality dimension has acquired direct knowledge of five specific analysers. **This is coupling by direct import rather than by port.** It is not a trust-correctness bug — the conservative direction is preserved (`negativeProjectionCoverage` weakens to PARTIAL unless `ABSENCE_ESTABLISHED`; not-required + semantic signal ⇒ `UNKNOWN`, not `NOT_REQUIRED`) — but it is the pattern Context OS must not copy.

**D3 — Coupling Context OS must explicitly avoid repeating.** Two rules, both derived from D2:

- **Do not let `ContextBuildResult` acquire a direct import of every knowledge source.** Context sources must register through a port, the way capabilities do, not the way `deriveSecurity` imports analysers.
- **Do not introduce a single `ContextCoverage` enum shared by all knowledge sources.** The `SECURITY.DEPENDENCY_VULNERABILITY_SCAN` comment (capability-adequacy.ts:335–338) is the governing precedent: *"Until the coverage model has a dependency-scope axis, this capability can carry concrete positive findings but no negative-absence claim."* The provider **declined to fabricate a FULL claim to fit the abstraction, and accepted reduced authority instead.** Context OS must do the same (see §K).

---

## E. Context OS domain model

Minimal canonical vocabulary. Reuses existing MAF nouns wherever they exist.

| Concept | Reuses / new | Home |
|---|---|---|
| `RepositorySnapshot` | **existing, unchanged** | ports.ts:208 |
| `RepositoryIndex.index/indexScope` | **existing, unchanged** — this *is* the pager backend | ports.ts:232 |
| `WorkingSet` | **new** — names what `initialFiles`/`initialModules` already are, adds provenance | `src/domain/working-set.ts` |
| `ContextBudget` | **new** — replaces the `slice(0,N)` literals | `src/domain/context-budget.ts` |
| `ContextLedger` / `ContextLedgerEntry` | **new** — generalises `contextExpansion` | `src/domain/context-ledger.ts` |
| `KnowledgeCapsule` | **new** — provenance-bound successor to `KnowledgeRecord` | `src/domain/knowledge-capsule.ts` |
| `KnowledgeState` | **new** — `CURRENT/STALE/UNKNOWN/CONFLICTED` | `src/domain/knowledge-capsule.ts` |
| `ProjectMemoryPort` | **new port**, backed by existing `ProjectBrain` | ports.ts |
| `ContextPagerPort` | **new port**, default impl wraps `RepositoryIndex` | ports.ts |

Deliberately **not** introduced: no ContextOS class, no orchestrator, no registry, no inheritance hierarchy, no new database. Per §30, the kernel is `WorkingSet` + `ContextBudget` + `ContextLedger` — three pure-domain value types and their derivations.

---

## F. State ownership

| State | Owner | Lifetime | Persisted |
|---|---|---|---|
| `RepositorySnapshot` | `ContextState` in RunService (run-service.ts:1077) | run | in signal snapshots |
| `WorkingSet` | `ContextState` (new field) | run, mutable via paging | in `ContextLedger` |
| `ContextBudget` | derived per build from Task + mode + risk | build | in ledger entry |
| `ContextLedger` | RunService, append-only | run | new table `011_context_ledger` |
| `KnowledgeCapsule` | `ProjectMemoryPort` | project, cross-run | brain store |
| Staleness state | **MAF only, never the provider** | — | with capsule |

Invariant: **an external memory provider may write capsule *candidates*; only MAF writes `KnowledgeState`.** Mirrors D1's provider/obligation split.

---

## G. Context layer model

Mapped onto existing code, not invented.

- **L0 Constitution** — mode + goal + revision + tool semantics. Exists: context-builder.ts:16–20, 74–77. Bounded by construction. ~50 tokens.
- **L1 Project Orientation** — module topology. Exists: `moduleMap`/`moduleOwnership`/`packageOwnership`, all **path-derived and content-free** (ports.ts:217–223), so L1 is already cheap at any repo size. Rendered at context-builder.ts:62–64. Must become budget-governed rather than `slice(0,4)`.
- **L2 Mission Working Set** — `initialFiles` + `initialModules` + symbols for those files (context-builder.ts:60–68). Becomes the explicit `WorkingSet`.
- **L3 Hot Pages** — on-demand slices. **Already implemented** as `indexScope` via `growGraph`/`growGraphTrusted` (run-service.ts:2983–3050).
- **L4 Cold State** — tracked files list, unparsed symbols, git history, brain records at other revisions. Costs zero prompt tokens today. Correct already.

**The layer model requires no new infrastructure.** L0/L1/L2 exist as unnamed slices; L3 exists as `indexScope`; L4 exists as "not read". Session 5's job is to make L2 explicit and L3 accounted.

---

## H. Working Set semantics

```ts
interface WorkingSetMember {
  uri: string;                    // repository-relative path (existing normalizeFile form)
  layer: "L1_ORIENTATION" | "L2_MISSION" | "L3_PAGED";
  reason: WorkingSetReason;
  authority: "OBSERVED" | "DERIVED" | "HEURISTIC";
  admittedAt: string;
  admittedBy: "PLANNER" | "AGENT_REQUEST" | "DIFF_OBSERVATION";
}

type WorkingSetReason =
  | "EXPLICIT_USER_SCOPE" | "CHANGED_FILE" | "LEXICAL_MATCH"
  | "IMPORT_RELATION" | "TEST_OF_MEMBER" | "AGENT_PAGE_FAULT"
  | "FALLBACK_UNRANKED";        // B4 — must be labelled, never silent

interface WorkingSet {
  members: WorkingSetMember[];
  budget: ContextBudget;
  omitted: Array<{uri: string; reason: "BUDGET" | "UNRANKED"}>;  // fixes B1 silent truncation
  truncated: boolean;
}
```

`authority` carries §11 directly: `IMPORT_RELATION` (from `snapshot.relations`, a resolved parse) is `DERIVED`; lexical match and historical co-change are `HEURISTIC`. **Heuristic authority may rank; it may never prove a dependency**, mirroring D1's positive-vs-negative split.

`omitted` is the fix for B1: what the budget cut is recorded, exactly as `filesTruncated`/`scopeTruncated` already do for the index.

---

## I. Minimum Effective Context policy

Constitutional triad becomes: Minimum Effective Intervention → **Minimum Effective Context** → Minimum Effective Assurance.

```ts
interface ContextBudget {
  maxMembers: number;
  maxSymbols: number;
  maxCapsules: number;
  estimatedTokenCeiling: number;
  basis: "MODE_DEFAULT" | "RISK_ADJUSTED" | "USER_OVERRIDE";
}
```

Derivation (pure function, `deriveContextBudget(mode, risk, task)`):
- `SOLO_NATIVE` → all zeros. Preserves B7 exactly.
- `GUIDED` → today's effective values (4 modules × 8 files, 60 symbols, 30 capsules) as the **named default**, so Session 5 is behaviour-preserving by default.
- `STRICT` → today's (2, 20, 30).
- Risk raises `maxCapsules` and `maxSymbols` only; it never raises `maxMembers` past the mission's own file scope.

**Hard invariant (§29, and the §32 test):** budget is an input to *context selection only*. It is not an input to `deriveAssuranceObligations`, `AssurancePlan`, or `QualityReport`. A smaller budget must be incapable of reducing required assurance. Enforced structurally — `ContextBudget` is not importable from the assurance modules — plus a test.

---

## J. Paging semantics

Operations, fitted to what the current index can actually answer (§13 says fit current ports, do not invent an API):

| Operation | Backed by | Available today |
|---|---|---|
| `get_file_slice` | worktree read | yes |
| `find_symbol` | `snapshot.symbols` | yes, for parsed files |
| `find_references` | `snapshot.relations` | yes, for parsed files |
| `related_files` | `moduleMap` | yes |
| `structural_search` | `RepositoryIndex.structuralSearch` (ports.ts:249) | yes |
| `dependency_impact` | relations closure | derivable |
| `history` / `incident_history` | — | **deferred to a later phase; do not stub** |

Fault path, matching the existing implementation:

```
member absent → agent requests slice → planner validates against budget + repository file set
  → indexScope (existing) → admit as L3_PAGED → append ContextLedgerEntry
```

Validation is the anti-poisoning gate (§29). `growGraph` already refuses agent strings that do not resolve against `snapshot.files` (run-service.ts:2990–2996) — **candidate-controlled metadata is already prevented from inventing repository members.** Session 5 adds the budget check and the ledger append on the same path.

Loop/thrash guards: per-run page-fault ceiling; a repeat request for an already-resident member is recorded as `REUSE` and served without re-indexing (the digest cache, project-brain.ts:317–321, already makes this free).

---

## K. Capsule / provenance model

```ts
interface KnowledgeCapsule {
  schemaVersion: 1;
  id: string; projectId: string;
  kind: KnowledgeKind;              // reuse existing FACT|INFERENCE|EVIDENCE|DECISION
  statement: string;
  scope: CapsuleScope;              // <-- the plural-axis decision
  sourceRevision: string;
  sourceDigests: Array<{uri: string; digest: string}>;  // from snapshot.evidence
  evidenceIds: string[];
  confidence: "OBSERVED" | "DERIVED" | "ASSERTED";
  state: KnowledgeState;
  stalenessTriggers: StalenessTrigger[];
  createdAt: string;
}

type CapsuleScope =
  | {axis: "FILE_SET"; uris: string[]}
  | {axis: "MODULE"; module: string}
  | {axis: "INTERFACE"; symbol: string; file: string}
  | {axis: "PROJECT_WIDE"};
```

**§3 compliance is the point of `CapsuleScope`.** There is deliberately **no `coverage: FULL|PARTIAL` field**. Following the `SECURITY.DEPENDENCY_VULNERABILITY_SCAN` precedent verbatim: a history-derived capsule and a symbol-derived capsule do not share a completeness notion, so no shared completeness field is offered. A capsule states *what it is bound to*, and authority follows from `confidence` + `kind` + binding — never from a self-asserted coverage claim.

Capsule types to actually implement in Session 5: **`INTERFACE` and `MODULE` only** — these are the two the current `RepositorySnapshot` can bind with real digests. `HistoryCapsule`, `IncidentCapsule`, `VerificationCapsule` are **deferred** (§X): the repository has no history/incident provider today, and building capsule types with no producer is speculative structure.

`confidence: ASSERTED` is the compression-preserves-uncertainty guarantee: a model-written statement can never be stored as `OBSERVED`, and the renderer must label `ASSERTED` capsules distinctly — fixing C3, where FACT and DECISION render identically under "Verified knowledge:".

---

## L. Staleness / invalidation model

```ts
type KnowledgeState = "CURRENT" | "STALE" | "UNKNOWN" | "CONFLICTED";

type StalenessTrigger =
  | {type: "SOURCE_DIGEST"; uri: string; digest: string}
  | {type: "MODULE_MEMBERSHIP"; module: string}
  | {type: "REVISION_GLOBAL"};    // conservative fallback
```

Evaluation, replacing `markStale`'s revision-global sweep (project-brain.ts:42–50):

1. Every `SOURCE_DIGEST` trigger matches current `snapshot.evidence` → `CURRENT`.
2. Any digest differs → `STALE`.
3. A trigger references a file **not yet parsed at this revision** → `UNKNOWN`. Not `CURRENT`.
4. Two `CURRENT` capsules with the same `scope` and contradictory statements → both `CONFLICTED`.
5. No usable triggers (`REVISION_GLOBAL`) → today's behaviour: stale on any revision change.

Rule 3 is the false-precision guard (§10): absence of a parse is not evidence of currency. Rule 5 preserves the existing conservative default for anything Session 5 cannot bind precisely.

**Non-negotiable:** only `CURRENT` capsules render into context. `STALE`, `UNKNOWN`, `CONFLICTED` may be *listed as existing* but never as fact — and re-verification, not re-reading, is the only transition back to `CURRENT`.

Consequence: because `INTERFACE`/`MODULE` capsules carry per-file digests, an unrelated commit no longer invalidates them. **This is the fix for C1/C2 and the mechanism behind the N+1 orientation metric.**

---

## M. Context Ledger

```ts
interface ContextLedgerEntry {
  schemaVersion: 1;
  runId: string; sequence: number; timestamp: string;
  event: "ADMITTED" | "PAGED_IN" | "OMITTED_BUDGET" | "REJECTED_STALE"
       | "REJECTED_UNRESOLVED" | "REUSED" | "TOUCHED_BY_DIFF";
  uri: string;
  layer: WorkingSetMember["layer"];
  reason: WorkingSetReason;
  authority: WorkingSetMember["authority"];
  sourceRevision: string;
  estimatedTokens: number | null;   // null = UNKNOWN, never 0
  requestedBy: "PLANNER" | "AGENT" | "SYSTEM";
}
```

Answers every §15 question. `TOUCHED_BY_DIFF` is the **observed** usefulness signal — derived by intersecting ledger URIs with the captured candidate's `changedFiles`, which RunService already has (`DeliveryHandoff.changedFiles`, delivery.ts:18). **This is deterministic and is the reason model retrospection is not needed as the primary source** (§15, §22).

Persistence: new migration `011_context_ledger.sql`, following the established payload+digest pattern of `008_delivery_handoff` / `009_production_feedback` (postgres/store.ts:568–615, 763–811).

---

## N. Metrics

All defined over ledger entries. **`estimatedTokens` is `number | null`; null means UNKNOWN and must never be summed as zero** (§16). This matches the existing correct precedent — `model-gateway.ts:82,105` already return `cost: null` rather than 0, and `health.ts:602` already documents "unknown, not zero".

| Metric | Definition |
|---|---|
| Orientation Tokens | Σ estimatedTokens of `ADMITTED` L0+L1 entries |
| Resident Context Peak | max over time of Σ resident member estimates |
| Context Expansion | count of `PAGED_IN` (today's `contextExpansion`, signal-collector.ts:404, generalised) |
| Page Fault Count | count of `PAGED_IN` with `requestedBy = AGENT` |
| Useful Context Ratio | `TOUCHED_BY_DIFF` ÷ admitted |
| Stale Context Rejection Rate | `REJECTED_STALE` ÷ capsule candidates |
| Context Reuse Ratio | `REUSED` ÷ (`REUSED` + `PAGED_IN`) |
| Cost per DVS | existing DVS ÷ recorded cost; `null` when cost unknown |
| **N+1 Orientation Cost** | Orientation Tokens for task *k+1* of the same task class, same project, after ≥1 verified success — the amortisation metric |

**Defect found (§27 relevant):** `model-gateway.ts:53–55` collapses absent token usage to `0` (`body.usage?.prompt_tokens ?? 0`) while correctly returning `cost: null`. Missing usage becomes zero tokens, which is exactly the UNKNOWN≠zero violation. **Noted; fix is a Session-5 non-goal** unless it blocks metric N.

---

## O. ProjectMemory provider boundary

```ts
interface ProjectMemoryPort {
  propose(candidate: CapsuleCandidate): Promise<void>;   // provider may write candidates
  query(q: CapsuleQuery): Promise<KnowledgeCapsule[]>;   // returns capsules with MAF-owned state
  status(): {backend: string; available: boolean};
}
```

Provider-neutral per §17; no TencentDB assumption. Default backend is the **existing** `ProjectBrain` implementation (project-brain.ts) — no new store.

Boundary rules:
- Provider supplies storage, retrieval, and candidate knowledge.
- **MAF alone** computes `KnowledgeState`, revision binding, conflict semantics, and authority. A provider cannot return `CURRENT`; MAF evaluates §L on read.
- `status().available === false` must degrade to zero capsules and a normal run. Tested (§W).

---

## P. Repository-intelligence provider boundary

Tiering already exists — `RepositoryIndexStatus.capability: "LOCAL_DETERMINISTIC" | "OPTIONAL_PORT" | "REAL_MCP"` (ports.ts:253–259), with a fallback-delegating wrapper at project-brain.ts:419–436.

- **Level 0** — current index. Mandatory, deterministic, path-derived. Already present.
- **Level 1** — SCIP-style symbol/reference provider. Optional, plugs into `indexScope`.
- **Level 2** — Joern/OpenGrep-class graph. Optional. (`opengrep-adapter.test.ts` exists, so the adapter pattern is established.)

Rule (§32, and the D1 precedent): **provider identity confers no trust.** A Level-2 provider raises `authority` only where it supplies a genuinely resolved relation, and the `WorkingSetMember.authority` value must be derived from the *kind of evidence*, never from the provider's name. Project Graph guides navigation and impact; it is never dumped into a prompt.

---

## Q. Mission Tree / decomposition interaction

`MissionTree` exists (mission-tree.ts:84) with `MissionHandoffBasis = "TRUSTED_CANDIDATE" | "CORRECTNESS_ONLY" | "UNDECLARED"` (mission-tree.ts:56–58).

Policy per §19: when a mission's required working set exceeds budget, the planner **must not raise the budget silently**. It emits a `DECOMPOSITION_SUGGESTED` signal. Decomposition remains conditional and human/mode-governed.

Anti-pattern guard (§29): decomposition must be *measured*, not assumed cheaper. Σ per-worker ledger tokens is compared against the single-agent baseline; if decomposition consumes more total context, that is recorded as a decomposition regression. **Decomposition gains no authority by producing more context** — enforced by `missionHandoffBasis`, which already refuses to upgrade trust for `UNDECLARED`/`CORRECTNESS_ONLY`.

---

## R. Structured handoff model

**Already largely solved.** `DeliveryHandoff` (delivery.ts:8–32) carries `candidateDigest`, `baseRevision`, `changedFiles`, `verification`, `trustState`, `quality`, `knownWarnings`, `evidenceRefs`, `policy.autoMergeAllowed: false`, and is digest-bound in storage (`deliveryHandoffDigest`, store.ts:615). It carries **no prose**.

Session-5 addition (small): an optional `contextSummary: {workingSetUris: string[]; unresolvedQuestions: string[]}`. **Worker transcripts are never passed** (§20). Agent A's prose is not instruction for Agent B — enforced by the handoff type having no free-text instruction field, which is already true today and must stay true.

---

## S. Evolution v2 (design only — not implemented in Session 5)

Thesis: verified experience reduces repeated engineering cost. The measurable claim is **N+1 Orientation Cost trending down at constant DVS rate**.

Optimisable: context policy (budget derivation, ranking weights), prompt selection, skill selection, model routing, strategy choice, assurance *scheduling*.
Not optimisable (§24): trust constitution, authority boundaries, meaning of PASS/UNKNOWN, deterministic verification requirements, merge eligibility, candidate/evidence binding.

The existing `StrategyLifecycle = "SHADOW" | "CANARY" | "PROMOTED" | "DEMOTED"` (strategy.ts:59) and `assessStrategy` (strategy.ts:363) are the correct host. Context policy becomes another `StrategyScope`, not a new subsystem.

---

## T. Holdout / promotion governance

Lifecycle (§23): observed experience → challenger → offline replay → regression suite → **digest-pinned frozen holdout** → shadow → explicit promotion → rollback. `strategy.ts` already provides shadow/canary/promote/demote and `deriveStrategyEvidenceBinding` (strategy.ts:253) for digest binding.

Holdout integrity (§25): dataset digest + version + task provenance recorded; a task that entered optimisation is permanently excluded from the holdout by ID; promotion history retained. **No challenger self-promotes** — promotion is an explicit authority-bearing action, and §24's immutables are not reachable from the optimiser's mutation surface.

---

## U. Self-hosting / circular-trust preparation

Not implemented (§26). Required property only: changes touching trust, candidate capture, evidence, authority, **context authority**, strategy authority, or evolution/promotion must be *capable* of triggering elevated independent assurance.

Preparation Session 5 actually performs: classify the new modules. `context-ledger.ts` and `knowledge-capsule.ts` are **authority-adjacent** (they gate what becomes fact); `working-set.ts` and `context-budget.ts` are **not** (selection only, and §I forbids budget from reaching assurance). This classification is what a future elevated-assurance rule keys on.

Invariant recorded: **MAF must never be the sole authority certifying a change to the mechanism that grants MAF authority.**

---

## V. Failure modes designed against

| Failure mode | Defence | Status |
|---|---|---|
| Memory growth → prompt growth | budget caps capsules; ledger measures | **B5 is a live instance — fix in S5** |
| Stale capsule served as current | only `CURRENT` renders (§L) | new |
| Incorrect dependency invalidation | digest triggers; `REVISION_GLOBAL` fallback | fixes C1 |
| History inference promoted to fact | `confidence: ASSERTED` never renders as verified | fixes C3 |
| Summary losing uncertainty | uncertainty is a typed field, not prose | new |
| Retrieval omission hiding a dependency | `omitted[]` recorded, never silent | fixes B1 |
| Agent requests entire project | budget validation on page-fault path | new |
| Page-fault loops / thrash | per-run ceiling; `REUSED` served from digest cache | new |
| Working-set poisoning | agent paths resolved against `snapshot.files` | **already defended**, run-service.ts:2990 |
| Provider memory types leaking into core | `ProjectMemoryPort`; capsule has no provider enum | per D3 |
| Symbol graph becoming mandatory | Level 1/2 optional; `RepositoryIndexStatus` | already true |
| Optimiser training on leaked holdout | digest-pinned, ID-exclusion | §T |
| Optimiser trading context for false-safe | budget structurally cannot reach assurance (§I) | new + test |
| Budget pressure reducing assurance | same | new + test |
| Decomposition duplicating context | measured against single-agent baseline (§Q) | new |

---

## W. Metamorphic / regression tests

Each maps to a §32 clause.

1. **`memory-scale.metamorphic.test.ts`** — 100× capsules for a project; the GUIDED working set for an unchanged local task grows by **0 members**, and rendered capsules stay ≤ `maxCapsules`. *(Directly targets B5.)*
2. **`irrelevant-files.metamorphic.test.ts`** — add 500 unrelated files; working set does not materially expand absent a relevance signal.
3. **`capsule-staleness.test.ts`** — change a capsule's source digest → `STALE`; unrelated commit → capsule stays `CURRENT` *(the C1 regression guard)*; unparsed trigger → `UNKNOWN`.
4. **`revision-representation.test.ts`** — re-render the revision string without new knowledge; no capsule gains authority.
5. **`memory-optionality.test.ts`** — `ProjectMemoryPort` present ↔ absent; run correctness semantics identical. *(Mirrors existing `capability-optionality.test.ts`.)*
6. **`repo-intelligence-equivalence.test.ts`** — provider A ↔ equivalent provider B; `authority` values identical, trust unchanged. *(Mirrors `no-vendor-leak.test.ts`.)*
7. **`context-budget-assurance-isolation.test.ts`** — shrink budget across its full range; `deriveAssuranceObligations` output is byte-identical. **The single most important new test.**
8. **`decomposition-authority.test.ts`** — decomposed ↔ single-agent; `missionHandoffBasis` does not improve for the decomposed path.
9. **`stale-context-authority.test.ts`** — a `STALE` capsule cannot reach a `CURRENT` verified fact by any code path.
10. **`context-ledger.test.ts`** — every admitted/omitted/paged member produces exactly one entry; no silent admission.

---

## X. Explicitly rejected / deferred complexity

**Rejected outright:**
- A `ContextOS` orchestrator class, registry, or framework (§30).
- A new database for context (§30) — reuse the existing Postgres store pattern.
- A universal `ContextCoverage` enum across knowledge sources (§3, per the D3 precedent).
- `maf://` URI scheme — repository-relative paths already work and `normalizeFile`/`findRepositoryFile` already resolve them. Adding a URI grammar buys nothing here. **§14's intent (reference before payload) is already satisfied by `initialFiles` + `indexScope`.**
- Replacing `GuidedContextBuilder` — it is 93 lines and structurally correct; it needs a budget and a ledger, not a rewrite.
- Duplicating `ProjectBrain` or `RepositoryIndex` (§30).

**Deferred to later phases:**
- `HistoryCapsule`, `IncidentCapsule`, `VerificationCapsule` — no producer exists (§K).
- `history` / `incident_history` page operations — would be stubs.
- Level-1/Level-2 repository intelligence providers.
- Learned context policy / Evolution v2 implementation.
- Self-hosting.
- `model-gateway.ts:53–55` UNKNOWN-vs-zero token fix — real, but out of scope.

---

## Y. Exact implementation phases

- **Phase 1 (Session 5)** — **foundation first, per §C0.** (a) Durable `ProjectBrain` backend + a real write path, so knowledge can exist and survive a restart; (b) explicit `WorkingSet`, `ContextBudget`, `ContextLedger`; (c) capsule base with `INTERFACE`/`MODULE` scopes and digest-based staleness — **only if (a) lands cleanly**, else deferred to Phase 1b; (d) pager contract over existing `indexScope`; (e) baseline metrics. Behaviour-preserving by default.
- **Phase 2** — capsule compilation producers; N+1 orientation measurement in benchmarks.
- **Phase 3** — Level-1 repository intelligence; relation-based ranking replacing lexical scoring (B3).
- **Phase 4** — external `ProjectMemoryPort` backend; history/incident capsules.
- **Phase 5** — Evolution v2 over context policy; holdout governance.
- **Phase 6** — self-hosting readiness.

---

# SESSION 5 IMPLEMENTATION CONTRACT

## Files to MODIFY

| File | Change |
|---|---|
| `src/domain/ports.ts` | Add `ContextPagerPort`, `ProjectMemoryPort`. Extend `ContextBuildResult` with `workingSet: WorkingSet` and `omitted`. Change `tokenEstimate` doc to state it is a character-heuristic estimate. **Do not change `RepositorySnapshot` or `RepositoryIndex`.** |
| `src/application/context-builder.ts` | Replace the `slice(0,N)` literals (lines 55–72) with `ContextBudget` values; emit `WorkingSet` with `reason`/`authority`; label the B4 fallback as `FALLBACK_UNRANKED`; **bound `evidenceIds` to rendered capsules only (fixes B5, line 87)**; distinguish `ASSERTED` from verified in the "Verified knowledge" section (fixes C3). Preserve the SOLO_NATIVE branch byte-for-byte. |
| `src/application/run-service.ts` | Add `workingSet` + `contextLedger` to `ContextState` (line 1077). Append ledger entries at build (1084), at `applyGraphGrowth` (3048), and at candidate capture for `TOUCHED_BY_DIFF`. Enforce budget on the page-fault path. **No change to run phase ordering.** |
| `src/infrastructure/project-brain.ts` | **(1)** Add a durable brain implementation (`PostgresProjectBrain`) alongside `InMemoryProjectBrain`; keep the in-memory one as the no-`DATABASE_URL` default, mirroring the run-store selection at `app.ts:332–337`. **(2)** Add digest-trigger staleness evaluation alongside existing `markStale`; keep `markStale` as the `REVISION_GLOBAL` fallback — **do not delete it**. **Note:** this file is misnamed and holds three concerns (brain `:16–56`, repository index `:58–410`, optional-port wrapper `:412–448`). **Do not split it in Session 5** — that is a rename-churn risk against a 113-entry dirty overlay. |
| `src/server/app.ts` | Select the durable brain when `DATABASE_URL` is set (line 338). |
| `migrations/011_context_ledger.sql`, `migrations/012_project_knowledge.sql` | Ledger table; knowledge table for the durable brain. |
| `src/domain/ports.ts` (doc fix) | `ports.ts:241` is **stale**: it says `indexScope` skips files already in `snapshot.parsedFiles`, but the implementation skips on **digest match** (project-brain.ts:321). `ports.ts:224` and the class comment `:198–201` are correct. Fix the comment only. |
| `src/infrastructure/postgres/store.ts` | Add `appendContextLedger` / `listContextLedger`, following the `008/009` payload+digest pattern. |
| `docs/design-docs/context-os-architecture.md` | Mark Phase 1 complete. |

## Files to CREATE

- `src/domain/working-set.ts` — `WorkingSet`, `WorkingSetMember`, `WorkingSetReason`, `deriveWorkingSet`
- `src/domain/context-budget.ts` — `ContextBudget`, `deriveContextBudget`
- `src/domain/context-ledger.ts` — `ContextLedgerEntry`, `appendEntry`, metric derivations (§N)
- `src/domain/knowledge-capsule.ts` — `KnowledgeCapsule`, `CapsuleScope`, `KnowledgeState`, `StalenessTrigger`, `evaluateCapsuleState`
- `migrations/011_context_ledger.sql`
- The ten test files in §W.

## Modules that MUST REMAIN FROZEN

`src/domain/assurance.ts`, `assurance-obligation.ts`, `capability-adequacy.ts`, `quality.ts`, `concern-*.ts`, `discovery-adequacy.ts`, `semantic-sensitivity.ts`, `verification-attribution.ts`, `policy-enforcement.ts`, `delivery.ts`, `strategy.ts`, `risk.ts`, `security.ts`, `mode-controller.ts`, `RepositorySnapshot`/`RepositoryIndex` in `ports.ts`.

Session 3's trust work is sound (§D). **Session 5 does not touch trust semantics.**

## Intended behaviour changes

1. **Project knowledge becomes durable and actually written** — the brain gains a Postgres backend and a production write path, so `list()` can return non-empty and the "Verified knowledge" section stops being a permanent fallback literal (§C0).
2. Context selection is budget-governed instead of magic-number-capped; **GUIDED/STRICT defaults reproduce today's output exactly.**
3. Omitted context is recorded, never silent.
4. `evidenceIds` is bounded to rendered capsules — closing B5 **before** the write path makes it live.
5. Capsules survive unrelated commits via digest triggers (C1/C2).
6. `ASSERTED` knowledge renders as unverified.
7. A per-run context ledger is persisted.
8. `UNKNOWN` and `CONFLICTED` become representable knowledge states.

## Non-goals

Evolution v2; learned policy; Level-1/2 providers; external memory backends; history/incident capsules; `maf://` URIs; replacing `GuidedContextBuilder`; mission decomposition changes; the `model-gateway` token fix; self-hosting; any trust-semantics change.

## Tests required

All ten in §W, plus: full existing suite green, with **`capability-*`, `promotion-authority-*`, `negative-authority-conservation`, and `quality-governance.integration` unchanged and passing without modification.** If any of those requires editing, **STOP** — it means trust semantics moved.

## Validation gates

1. `capability-adequacy.test.ts`, `promotion-authority-*.test.ts`, `negative-authority-conservation.test.ts` pass **unmodified**.
2. `context-budget-assurance-isolation.test.ts` passes — budget cannot influence assurance.
3. `memory-scale.metamorphic.test.ts` passes — 100× memory, 0 working-set growth.
4. Default-budget GUIDED context text is **byte-identical** to pre-change output for a fixture task.
5. Biome/tsc clean; no new dependency; no new service.
6. Dirty-tree accounting: **113 modified entries pre-session**; post-session count must equal 113 + exactly the created files listed above.

## STOP conditions

Halt and report rather than proceeding if:

- A change to `assurance-obligation.ts`, `capability-adequacy.ts`, or `quality.ts` appears necessary.
- Any frozen test requires modification to pass.
- `ContextBudget` needs to be imported by any assurance/quality module.
- Capsule design pressures you toward a single universal coverage enum (§3 / D3 violation).
- `RepositorySnapshot` or `RepositoryIndex` needs a signature change.
- Ledger persistence appears to need a new datastore.
- Behaviour-preservation gate 4 cannot be met — reconcile the budget defaults before continuing.
- **Splitting `project-brain.ts` into separate modules starts to look necessary** — it is a 448-line file with three concerns, but rename churn against a 113-entry dirty overlay is a Session-6 task.
- Scope exceeds one implementation session. Shed in this order, keeping the foundation: ship **durable brain + write path + `working-set.ts` + `context-budget.ts` + `context-ledger.ts` + tests**, and defer **capsule provenance/staleness** to Phase 1b. Capsules without a durable, written store deliver nothing; the ledger and budget deliver value immediately.
