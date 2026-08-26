# Session 8.5 — Understand Anything architecture evaluation

Status: COMPLETE (research and architecture decision recorded on 2026-08-24)

Overall integration classification: **DESIGN_REFERENCE_ONLY**

Production-code decision before the unseen benchmark: **NO**

## Executive decision

Understand Anything (UA) has two non-duplicative strengths relative to current MAF plus SCIP:

1. model-derived semantic orientation — summaries, architecture layers, business domains, flows,
   and guided tours; and
2. a mature set of graph-exploration interaction primitives — search, filtering, focus, path
   finding, source detail, guided traversal, domain/structural view switching, and changed/affected
   overlays.

Those strengths are useful as design evidence, but the current upstream artifact is not suitable as
a MAF knowledge or trust source. UA's persisted graph flattens parser-derived observations and
model-derived claims into the same node and edge schema without per-record provenance. Its
incremental update and persistence paths have had material correctness failures, two important
failure modes remain open on the inspected revision, and its normal analysis still pays substantial
model-orchestration cost. Its freshness model is graph/commit oriented rather than MAF's
source-dependency and page-resolution model.

The decision is therefore:

- **COMPLEMENTS SCIP, narrowly**, for semantic orientation and human exploration;
- **mostly duplicates SCIP + MAF** for definitions, navigation, file/module topology, change
  selection, and stale-data control;
- **does not justify a production adapter or prototype now**; and
- **is a useful Session 9 UX reference**, provided MAF renders its own provenance, freshness,
  completeness, authority, and trust states rather than copying UA's graph semantics.

No production code, dependency, migration, external runtime, graph import, or provider seam is
added by this session.

## A. Current upstream status and license

Research was performed against the official
[Egonex-AI/Understand-Anything repository](https://github.com/Egonex-AI/Understand-Anything) on
2026-08-24.

| Item | Verified state |
| --- | --- |
| Default branch | `main` |
| Inspected commit | [`32944829e7a63a9fa9c55d811d7f98a9530c6a6a`](https://github.com/Egonex-AI/Understand-Anything/commit/32944829e7a63a9fa9c55d811d7f98a9530c6a6a), committed 2026-08-11 |
| Latest release | [`v2.9.0`](https://github.com/Egonex-AI/Understand-Anything/releases/tag/v2.9.0), published 2026-07-10 |
| License | [MIT](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/LICENSE) |
| Repository state | Active and not archived at the time of inspection |

The inspected `main` commit is newer than the latest release, so all implementation conclusions in
this report bind to that commit, not just to `v2.9.0` marketing or release notes. No claim is made
about later commits.

## B. Architecture summary

UA is a plugin/skills-based analysis system with three main parts:

1. A TypeScript core provides the graph types/schema, Tree-sitter plugins, language extractors,
   fingerprint and change classification, persistence helpers, lexical search, an embedding search
   class, graph builders, and staleness utilities.
2. Skills and agent definitions orchestrate repository scanning, batched file analysis, graph
   assembly, architecture-layer analysis, tour generation, optional graph review, domain analysis,
   diff analysis, onboarding, chat, and dashboard launch.
3. A React/React Flow dashboard reads local graph JSON and provides structural and domain views.

The current `/understand` path is approximately:

```text
Git/project preflight
  -> deterministic inventory + ignore filtering
  -> Tree-sitter/specialized structural extraction and import map
  -> deterministic batching/neighbor context
  -> model file-analyzer batches
  -> merge + normalize + deterministic import recovery
  -> model architecture-layer analysis over the merged graph
  -> model tour generation
  -> deterministic validation (optional model reviewer)
  -> knowledge-graph.json + fingerprints.json + meta.json
```

The split is visible in the pinned
[`/understand` skill](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/skills/understand/SKILL.md),
[`file-analyzer`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/agents/file-analyzer.md),
[`architecture-analyzer`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/agents/architecture-analyzer.md),
and
[`tour-builder`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/agents/tour-builder.md).

Structural extraction is real, not merely advertised. The checked-in
[`TreeSitterPlugin`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/packages/core/src/plugins/tree-sitter-plugin.ts)
loads configured WASM grammars and language extractors for functions, classes, imports, exports,
and call sites. Non-code parsers cover formats such as Dockerfile, SQL, GraphQL, Protobuf,
Terraform, YAML, JSON, shell, Markdown, and Makefiles. However, the file-analyzer agent still
selects significant nodes, writes summaries/tags/complexity, and emits the graph batch. The final
graph is therefore a hybrid artifact, not a parser-only index.

The current core
[`KnowledgeGraph` schema](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/packages/core/src/types.ts)
contains project metadata, nodes, edges, layers, and tour steps. The shared type universe has 27
node types and 38 edge types because it also covers knowledge-base and Figma graphs. Codebase graphs
use a smaller subset, but still combine structural, behavioral, semantic, infrastructure, and
domain concepts.

Persistence is local JSON in `.ua/` (or legacy `.understand-anything/`):
`knowledge-graph.json`, `meta.json`, `fingerprints.json`, `config.json`, and optional
`domain-graph.json`. The core
[`persistence helpers`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/packages/core/src/persistence/index.ts)
use direct filesystem writes. They validate on load, but they do not provide a transaction spanning
graph, metadata, fingerprints, or domain graph.

## C. Structural-versus-semantic provenance model

UA's implementation contains a meaningful structural/semantic split, but its persisted graph does
not preserve that split with enough fidelity for MAF. MAF must classify any future input at record
or field granularity, not by the fact that it arrived in a `knowledge-graph.json` file.

| Provenance class | UA examples | MAF interpretation |
| --- | --- | --- |
| `STRUCTURAL / DETERMINISTIC-ish` | tracked files, language/category inventory, Tree-sitter functions/classes/imports/exports/call sites, specialized parser definitions, resolved internal import map, content hashes, structural fingerprints | Candidate structural observation only. To become MAF evidence it must bind the exact file digest, parser/extractor version, configuration/rules digest, parse success, language coverage, and completeness. |
| `SEMANTIC / MODEL-DERIVED` | file/function/class summaries, tags, complexity, project description, framework interpretation, architectural layer names/assignments/descriptions, most behavioral/data/infrastructure relationships, business domains, business rules, flows, steps, guided-tour prose, language lessons | `INFERENCE` or UI interpretation, never `FACT` merely because it passed schema or referential-integrity validation. It needs model/provider/prompt-policy identity, source anchors, affected-slice completeness, and explicit stale handling. |
| `HYBRID / AMBIGUOUS IN THE PERSISTED GRAPH` | `calls`, `imports`, `implements`, `tested_by`, and other edges may have parser, deterministic recovery, path heuristic, or model origins; file/function nodes combine parser identity with model summary/tags/complexity | Treat conservatively as semantic/candidate unless independent per-item provenance proves a deterministic origin. Edge type or weight is not provenance. |

The schema has project-level `gitCommitHash` and `analyzedAt`, but `GraphNode`, `GraphEdge`, `Layer`,
and `TourStep` have no producer, model, parser version, source digest set, completeness, evidence
references, or authority field. Graph validation proves shape and endpoint integrity; it does not
prove the semantic truth of a summary, relationship, layer, business rule, or flow.

Critical invariant:

```text
UA graph edge != verified project truth
```

No UA graph record may enter ProjectBrain as a verified `FACT` without independent evidence that
satisfies MAF's own provenance and compilation rules.

## D. SCIP-versus-UA-versus-MAF comparison

`Current MAF built-in` below means MAF's local deterministic index, ProjectBrain, compiled module
knowledge, and Context OS. SCIP is shown separately even though Session 8 already connects it as an
optional MAF provider. `Unique value` is evaluated against their combined actual capability.

| Capability | SCIP | Understand Anything | Current MAF built-in | Unique value beyond MAF + SCIP |
| --- | --- | --- | --- | --- |
| Symbol definitions | Semantic-document occurrences and definitions when the language indexer records them | Tree-sitter/parser definitions with line ranges, then significance filtering and model-emitted graph nodes | Bounded local declaration extraction; optional SCIP already supplies semantic definitions | None material; UA is less precise and less provenance-safe than SCIP for navigation |
| References | Direct symbol occurrences, subject to indexer coverage | Not identifier-complete; primarily file imports, parser call sites, and model/heuristic edges | Local imports only; optional SCIP supplies direct references | None for exact references |
| Implementations | Explicit SCIP relationships when indexer emits them | `implements` is a graph edge type, but the persisted artifact does not prove parser versus inference origin | Optional SCIP exposes `FIND_IMPLEMENTATIONS` | None trustworthy |
| File structure | Documents are present as index units, but SCIP is not a general non-code project inventory | Broad code and non-code classification, functions/classes, configs, schemas, services, endpoints, pipelines, resources | All tracked paths, path-derived package/module ownership, selected-file symbols and imports | Modest: typed non-code inventory; useful only if exact parser provenance is preserved |
| Module relationships | Can support derivation but does not define MAF modules | Imports plus many behavioral/dependency relationships and model architecture layers | Deterministic path-derived modules, resolved local imports, digest/membership-bound `MODULE_BOUNDARY` facts | Model layer interpretation is unique but candidate-only; trusted topology is duplicated |
| Semantic descriptions | None | File/symbol/project summaries, tags, complexity, language notes | Deliberately absent from compiled facts | Yes: useful candidate orientation, not truth |
| Architecture layers | None | Model-assigned 3–10 layers using path/import topology plus summaries | Deterministic path-derived module boundaries, not semantic layer names | Yes: useful onboarding/UI grouping, not verified architecture |
| Business/domain flow | None | Model-derived domains, flows, steps, business rules, and cross-domain interactions | None | Yes, potentially valuable, but reproducibility and source grounding are unverified |
| Incremental update | Indexer-specific; MAF binds a finished artifact | Manual commit diff plus a separate fingerprint-driven auto-update flow | Per-file digest reparse on scope growth; source/membership revalidation at every knowledge/page read | No; UA is more complex and has weaker failure containment |
| Stale-data handling | MAF revalidates revision, artifact digest/version/age, document set, and document digests | Graph-level commit/dirty status plus fingerprints; no per-node source-dependency state | `CURRENT/STALE/UNKNOWN/CONFLICTED`, source-digest and membership bindings, page-time rejection | No; MAF is materially stronger |
| Search | Provider/indexer query semantics | Fuse lexical/fuzzy search across name/tags/summary/language notes; embedding engine exists but dashboard semantic mode still uses Fuse | Task ranking, structural search, symbol/context-page operations | Modest UI convenience; semantic recall depends on model text and has no current embedding pipeline |
| Human visualization | None | Rich structural/domain dashboard with drilldown, filters, path finder, details, source view, tours, diff overlay | Current dashboard is operational/evidence oriented; no comparable project graph | Yes: strong design reference |
| Diff analysis | None in the format itself | Maps changed files to graph nodes, expands one hop, shows affected layers and a dashboard overlay | Candidate diff, changed files, relations, risk/evidence/trust data exist but are not yet a project-map overlay | Yes as a UI pattern; UA's one-hop result is impact exploration, not proof of blast radius |

Conclusion: **UA complements SCIP only in semantic orientation and UX.** Its structural repository
intelligence mostly duplicates existing MAF + SCIP, with lower authority and more orchestration.

## E. Incremental and fingerprint mechanisms

### Manual `/understand` path

The manual skill decides between full and incremental analysis using the existing graph/meta commit
and `git diff <lastCommitHash>..HEAD --name-only`. On an incremental run it computes batches only for
changed files, removes old nodes for those files and incident edges, writes the retained graph as
`batch-existing.json`, and merges it with fresh model-produced batches. Current `main` explicitly
special-cases `batch-existing.json` in
[`merge-batch-graphs.py`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/skills/understand/merge-batch-graphs.py).

For manual incrementals, the skill instructs architecture analysis to run over the full merged node
set because layer assignments may shift. This makes local file re-analysis incremental while a
global semantic stage remains global.

The full save path generates a new Tree-sitter-based fingerprint baseline before writing `meta.json`.
That ordering is a sound lesson: do not advance the durable baseline until the dependent artifact
exists.

### Auto-update hook path

The separate checked-in
[`auto-update-prompt.md`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/hooks/auto-update-prompt.md)
instructs the host model to create a temporary regex-based fingerprint comparator. Changes are
classified as:

- `NONE`: identical content hash;
- `COSMETIC`: content changed but selected function/class/import/export structure did not;
- `STRUCTURAL`: selected structural signatures changed;
- then `SKIP`, `PARTIAL_UPDATE`, `ARCHITECTURE_UPDATE`, or `FULL_UPDATE` by count, percentage, and
  directory heuristics.

The checked-in core
[`fingerprint.ts`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/packages/core/src/fingerprint.ts)
stores content hash, functions, classes, imports, exports, line counts, and whether structural
analysis was available. Files without structural analysis fail conservatively to `STRUCTURAL` when
changed. Supported files can be classified `COSMETIC` even when implementation logic changed.

That is appropriate only for structural topology. It is unsafe as semantic staleness logic: a
business rule can change inside an unchanged function signature, making its summary, domain flow,
complexity, or tour explanation stale even though the update is skipped. MAF must not borrow the
claim that internal logic has “no impact” on semantic knowledge.

The auto-update prompt now specifies load-patch-save for fingerprints and refuses to overwrite a
non-empty file that parsed as an empty store. That is a useful corruption guard. However, its save
sequence writes graph, then metadata, then fingerprints, and all are ordinary file writes. A failure
between them can leave mixed generations. Actual host-model execution of the temporary comparator
is also not a single versioned implementation. These mechanisms are weaker than MAF's atomic
ProjectBrain publication and digest-bound page resolution.

### Graph merge

The merge path normalizes node/edge fields, deduplicates IDs/edge keys, drops dangling references,
recovers deterministic imports, normalizes complexity and types, and emits a merge report. It is
valuable resilience engineering for a model-produced interchange format, but it also demonstrates
that a valid final graph can contain repaired, dropped, heuristic, and model-generated material
without per-record origin metadata. The normalizer may improve shape; it cannot confer truth.

### MAF implication

MAF already has the safer mechanisms:

- per-file SHA-256 digest caching and reparse in `RepositoryIndex.indexScope()`;
- source/membership-bound knowledge revalidation;
- explicit `CURRENT`, `STALE`, `UNKNOWN`, and `CONFLICTED` resolution;
- atomic ProjectBrain batch publication;
- provider artifact/document revalidation for SCIP; and
- bounded Context Pages that reject stale results before admission.

No UA incremental mechanism should replace or sit beneath those invariants.

## F. Scaling characteristics

### Upstream characteristics

- Full analysis sends model file-analyzer batches, currently described as 20–30 files per batch with
  up to five concurrent analyzers, then runs whole-graph semantic stages.
- The persisted graph and dashboard are whole-graph artifacts. Dashboard loading and Fuse indexing
  are proportional to all nodes, and layout is computed over selected graph views.
- UA's chat context builder limits initial search matches (default 15) but expands every matched node
  to all one-hop neighbors without a character, token, relation-count, or resident-context ceiling.
- The domain-analysis path can format all nodes, edges, layers, and tour steps as model context when
  deriving a domain graph from an existing graph.
- Incremental file analysis does not guarantee incremental semantic cost: architecture analysis may
  run over the full merged graph, and domain analysis is a separate global inference.
- UA ships a
  [deterministic large-repository benchmark](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/docs/benchmarks/large-monorepo.md),
  but its own documentation says it does not run an LLM, count tokens, estimate cost, generate the
  semantic graph, or constitute an end-to-end `/understand` benchmark. Therefore end-to-end large
  repository cost and semantic quality remain unverified by that benchmark.

### MAF fit

UA is compatible with Minimum Effective Context only if treated as a cold optional provider whose
global artifact is never resident in a normal task. A query must retrieve a bounded affected slice,
then MAF must resolve it into canonical handles/pages and enforce the existing page/item/character
budgets.

These are scaling mismatches and must be rejected:

- full `knowledge-graph.json` in a prompt;
- all one-hop neighbors without a page-item ceiling;
- global domain/layer regeneration as a prerequisite for a local task;
- multi-agent semantic analysis on every repository change; and
- treating long context as a substitute for slice selection and durable state.

## G. Known upstream failure modes

Issues are first-party project-history evidence of reported failures, not independent proof that
every environment or current commit still reproduces them. Status and current-code inspection are
called out explicitly.

| Failure | Upstream evidence/status | Does current MAF prevent it? | Adoption risk / safe lesson |
| --- | --- | --- | --- |
| Fingerprint store overwritten by a partial batch, causing recurring full analysis | [Issue #152](https://github.com/Egonex-AI/Understand-Anything/issues/152), closed. Current prompt has explicit load-patch-save and an empty-load guard. | Atomic ProjectBrain batches, immutable record identity, and source-digest reads prevent a partial authoritative batch from replacing unrelated knowledge. | Importing UA persistence could reintroduce generation skew. Keep MAF atomic publication; adapt only the “load full state, patch exact slice, validate before advancing baseline” lesson. |
| Incremental merge silently dropped all unchanged nodes because `batch-existing.json` did not match the numeric batch regex | [Issue #402](https://github.com/Egonex-AI/Understand-Anything/issues/402), closed. Current merge code special-cases that filename. | MAF does not rebuild canonical knowledge by replacing one global graph JSON; atomic add-batch and deterministic identity preserve unrelated records. | Do not adopt the global prune-and-replace graph merge. Validate complete retained/new coverage if a future provider publishes a new artifact. |
| Context compaction after many batches loses all accumulated update work before the final write | [Issue #433](https://github.com/Egonex-AI/Understand-Anything/issues/433), open on 2026-08-24. The report describes about 1.2M tokens in one observed large update; that number is anecdotal, not a benchmark. | MAF persists engineering state, run events, candidates, verifications, and recovery capsules outside model context. | A future semantic-analysis job must persist each slice and merge checkpoint before continuing. Agent context must never be the only state store. |
| Incremental path reuses a stale import map, so new imports can remain invisible until a full scan | [Issue #590](https://github.com/Egonex-AI/Understand-Anything/issues/590), open on 2026-08-24 and reported against v2.9.0. | MAF rehashes changed files on `indexScope()`, reparses their imports, and rejects source-digest mismatches; SCIP pages revalidate document bindings. | A UA graph adapter could reintroduce stale edges. Any future provider must re-extract deterministic dependencies for exactly the changed slice before publication. |
| Incremental update reportedly used more tokens than the initial build after a small change | [Issue #611](https://github.com/Egonex-AI/Understand-Anything/issues/611), open and unanswered at inspection. | MAF resident context and page counts are hard bounded, but an out-of-band provider job could still be expensive. | Treat as an unresolved cost signal, not a quantified fact. Require end-to-end token/cost benchmarks before any semantic provider pilot. |
| Large repository fan-out, high token use, and agent drift | [Issue #461](https://github.com/Egonex-AI/Understand-Anything/issues/461), closed as not planned, consolidates several reports; [Issue #76](https://github.com/Egonex-AI/Understand-Anything/issues/76) remains an open performance question. | MAF does not require global multi-agent repository analysis for local work and preserves native search. | Reject UA's orchestration topology. If semantics are tested later, run them optional, offline, and only on affected slices. |
| Cross-batch model output produces wrong-prefix/dangling edges requiring repair | [Issue #303](https://github.com/Egonex-AI/Understand-Anything/issues/303), open. | Canonical MAF handles contain no provider-owned symbol ID and page sources validate project/revision/digest and canonical shape. | Never expose UA IDs as canonical IDs. Resolve provider items through a MAF anti-corruption layer and retain their candidate provenance. |
| Semantic hallucination or over-interpretation | No single verified upstream issue was found that measures a hallucination rate. Direct inspection shows model-written summaries, relationships, layers, domains, flows, and tours, while validation checks shape/referential integrity rather than semantic truth. | ProjectBrain rejects unsupported facts; compiled knowledge is currently deterministic `MODULE_BOUNDARY` only; Context Pages are `CONTEXT_ONLY`. | The risk is architectural and remains unquantified. Treat every such record as inference until separately supported. |

The current MAF prevents most of these failures from strengthening trust, but adopting UA as a
canonical graph or direct prompt source would bypass those protections and reintroduce them at the
context layer.

## H. Context OS compatibility

The only acceptable future flow remains:

```text
Understand Anything (optional, cold, replaceable)
  -> provider-neutral semantic repository-intelligence adapter
  -> MAF canonical candidate graph/knowledge projection
  -> Context OS handle
  -> bounded, source-revalidated Context Page
  -> mission Context Working Set
```

The current `RepositoryIntelligenceProvider` is deliberately narrower than a UA semantic graph: it
supports symbol, definition, reference, and implementation operations. Session 8.5 does not widen
that interface. If a future benchmark proves value, a separate provider-neutral semantic retrieval
contract could expose operations such as `FIND_CONCEPT`, `FIND_DOMAIN_FLOW`, or
`RELATED_SUBSYSTEMS`; it must not add UA types to domain/application code.

Any future semantic result would need at least:

- project and resolved revision;
- artifact and schema digest/version;
- per-item structural versus model-derived provenance;
- parser/extractor or model/provider identity;
- prompt/policy/configuration digest for model-derived material;
- exact source file/digest anchors;
- indexed time, language/scope coverage, and completeness;
- affected-slice identity and stale dependencies; and
- `CANDIDATE`/`INFERENCE` plus `CONTEXT_ONLY` authority.

The page source must revalidate those bindings, clip by item and character count, generate canonical
MAF handles, and reject stale or malformed output. Provider silence is not proof of absence.

Invalid under all classifications:

- Prompt Compiler reading UA files;
- UA graph becoming a MAF project fact;
- UA edge weight becoming confidence or authority;
- full graph injection;
- UA freshness overriding MAF freshness; or
- UA review/validation affecting verification, assurance, trust, promotion, or merge eligibility.

## I. Semantic and domain-graph value

### Semantic project model

| Concept | Potential MAF value | Correct status if retained |
| --- | --- | --- |
| File/symbol summary | Faster orientation and better semantic query recall | `SEMANTIC INFERENCE`; candidate context only |
| Architecture layer | UI grouping, onboarding, weak context-ranking feature | `SEMANTIC INFERENCE`; never deterministic module truth unless independently compiled |
| Subsystem role | Mission-to-repository retrieval hint | `SEMANTIC INFERENCE` with structural anchors |
| Business domain | Maps user vocabulary to code vocabulary | `CANDIDATE` semantic concept until benchmark and review establish usefulness |
| Business flow/step | Onboarding and impact exploration | `CANDIDATE`/UI interpretation; each step should cite exact structural anchors |
| Project tour | Guided exploration and learning | `UI-ONLY INTERPRETATION`; no authority |

### Domain/business graph

The proposed retrieval path is genuinely useful in principle:

```text
"change SSO login"
  -> candidate Authentication domain
  -> candidate Login/Identity/Session flow
  -> source-anchored modules/files
  -> SCIP definitions/references/implementations
  -> bounded Working Set
```

It could materially improve mission vocabulary matching, onboarding, and exploratory impact
analysis when product language differs from identifier/path language.

Current UA does not yet justify trusting that mapping. Its
[`domain-analyzer`](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/understand-anything-plugin/agents/domain-analyzer.md)
derives domains from either sampled source context or the existing graph's summaries, tags,
relationships, layers, and tours. Step file paths are optional, and the schema carries no evidence
or generation provenance. When based on an existing graph, the domain inference can compound prior
model inferences. Reproducibility, precision/recall, terminology stability, and change sensitivity
are unverified.

The unseen benchmark must therefore test, at minimum:

1. repeated-run stability for the same revision and model/policy;
2. correct mapping from domain-language requests to independently relevant files/symbols;
3. false-positive and false-negative subsystem expansion;
4. performance versus MAF lexical/path/module/SCIP retrieval alone;
5. context tokens admitted after MAF paging, not graph size;
6. changed-business-logic invalidation when signatures do not change; and
7. usefulness to humans for onboarding and impact exploration.

Until then the domain graph is a promising hypothesis, not an integration gap proven closed.

## J. Mission Compiler implications

Mission compilation must remain deterministic and authority-preserving. A semantic graph may help
retrieve candidate scope after the Mission Contract exists; it must not define the Mission
Contract, acceptance criteria, risk, authority, verification obligations, or execution mode.

Safe future use:

1. compile the Mission Contract from user input and MAF policy as today;
2. use mission terms to query a bounded candidate semantic slice;
3. resolve candidate concepts to source-anchored MAF handles;
4. confirm/expand through deterministic modules and SCIP navigation;
5. rank the resulting items as weak semantic hints, with provenance visible; and
6. admit only bounded pages to the Working Set.

Unsafe use:

- treating a domain label as declared scope;
- treating a tour as execution instructions;
- treating an inferred dependency as impact proof;
- increasing or reducing assurance because the graph says a component is simple/complex; or
- allowing semantic output to trigger an execution-mode transition without independent MAF
  evidence. Every transition must continue to emit its existing reason and evidence.

## K. ProjectBrain implications

No current ProjectBrain schema change is warranted.

- Parser observations could become `EVIDENCE` only after exact file digest, producer/version,
  configuration, coverage, and parse-success binding. Session 8's SCIP/context-page path already
  supplies the higher-value navigation without publishing these observations as facts.
- Summaries, architecture layers, subsystem roles, domains, flows, business rules, and tours must
  not enter the existing deterministic compiled `MODULE_BOUNDARY` fact lane.
- If future benchmarks justify durable semantic memory, records belong in an explicit semantic
  `INFERENCE`/candidate lane with per-record sources and staleness dependencies. Existing producer
  and compilation enums should not be stretched merely to fit UA.
- Conflicting semantic interpretations must remain representable and withheld from fact rendering;
  model confidence must not stand in for evidence.
- Publication must be atomic or versioned/checkpointed. A global mutable graph file must never
  replace ProjectBrain's canonical durable state.

`Knowledge graph edge != verified project truth` remains the controlling invariant.

## L. Project Map and UI patterns worth borrowing

UA's highest-confidence contribution to Session 9 is interaction design. The useful primitives are:

1. **Overview to detail:** project/layer clusters first, then drill into a layer/container, then a
   node and its local relationships.
2. **Search as navigation:** fuzzy match names, paths, summaries, and tags; search result selection
   should focus the node without expanding the whole graph.
3. **Explicit filters:** node/evidence kind, freshness, completeness, authority, source, module, and
   change state. MAF should substitute evidence/trust filters for UA's ambiguous complexity/persona
   semantics.
4. **Focus plus bounded neighborhood:** show a selected node and a page-limited neighborhood, with
   “load more” through Context OS rather than rendering an unbounded connected component.
5. **Path finder:** find an explanatory path between two selected canonical nodes; label every edge
   by provenance and never call the path proof of causation.
6. **Node detail and source linking:** show summary/role separately from exact file/symbol anchors,
   source revision/digest, producer, freshness, completeness, and authority.
7. **Breadcrumb/history:** preserve exploration history when moving across layers/nodes.
8. **Changed versus affected overlay:** direct candidate changes in one treatment; structurally or
   semantically adjacent candidates in another. “Affected” must be labelled exploratory, not
   verified blast radius.
9. **Guided exploration:** tours can teach the repository, but tour content is UI interpretation and
   should cite nodes/anchors.
10. **Structural/domain toggle:** useful only when the domain view clearly says `SEMANTIC
    INFERENCE` and can pivot back to deterministic/SCIP anchors.
11. **Staleness banner:** surface `STALE`, `UNKNOWN`, and `CONFLICTED` as first-class states rather
    than hiding unavailable data.
12. **Large-graph rendering:** container aggregation, lazy child layout, and aggregated edges are
    useful UI techniques. The upstream
    [layout scaling design](https://github.com/Egonex-AI/Understand-Anything/blob/32944829e7a63a9fa9c55d811d7f98a9530c6a6a/docs/superpowers/specs/2026-05-03-graph-layout-scaling-design.md)
    is a reference, not a design to copy wholesale.

Do not copy UA's visual style, node/edge taxonomy, edge weights, complexity labels, persona semantics,
or graph-wide loading model.

## M. Mechanism-by-mechanism decision matrix

| Mechanism | Decision | Rationale / boundary |
| --- | --- | --- |
| UA runtime or production graph adapter | `DEFER` | Unique semantic value is unbenchmarked and current artifact provenance is insufficient. No seam or prototype before the unseen benchmark. |
| Tree-sitter multi-language structural extraction | `DEFER` | Real and broader than MAF's local regex parser, but SCIP already closes the priority symbol-navigation gap. Re-evaluate only if a measured non-code/language gap remains. |
| Deterministic import map as a MAF dependency source | `REJECT` | Duplicates MAF local imports/SCIP and has a current stale-map failure. |
| UA graph schema as canonical MAF schema | `REJECT` | Mixes structural and semantic material without per-record provenance, freshness, completeness, or authority. |
| File/symbol summaries and tags | `PROVIDER_ONLY` | Candidate semantic retrieval input; never fact/trust. Only behind a future bounded provider if benchmarked. |
| Architecture layer inference | `PROVIDER_ONLY` | Candidate grouping/ranking and UI interpretation; deterministic MAF module boundaries remain canonical. |
| Business/domain flow graph | `DEFER` | Potentially unique and useful, but source grounding and reproducibility are unproven. |
| Guided tour content | `UI_REFERENCE` | Valuable onboarding interaction; content remains UI-only interpretation with source anchors. |
| Git-diff change selection | `REJECT` | Commit-only selection is weaker than live source-digest and working-set revalidation. |
| Structural fingerprint classification | `REJECT` | Signature equality cannot keep semantic claims current when internal behavior changes; MAF already has safer digest-based staleness. |
| Load-patch-save corruption guard | `ADAPT` | Retain as a general self-hosting lesson, strengthened to transactional/versioned publication and baseline-last ordering. MAF already applies the stronger form to ProjectBrain. |
| Per-batch durable intermediate results | `ADAPT` | Any future semantic analysis must checkpoint slice results outside agent context before global merge/compaction. |
| Global prune/merge/normalize pipeline | `REJECT` | Shape repair and silent dropping cannot be a canonical truth publication path. |
| Fuzzy search | `UI_REFERENCE` | Useful navigation primitive. Keep retrieval bounded and label semantic fields as inference. |
| Embedding search | `DEFER` | Core class exists, but dashboard semantic mode still uses fuzzy search and no inspected end-to-end embedding provenance/persistence pipeline was verified. |
| Overview/layer/node drilldown | `UI_REFERENCE` | Strong Session 9 interaction primitive over a MAF-owned read model. |
| Path finder and focus neighborhood | `UI_REFERENCE` | Useful exploration if page-bounded and provenance-labelled. |
| Diff changed/affected overlay | `UI_REFERENCE` | Map MAF's candidate-bound diff and evidence; do not present one-hop adjacency as verified impact. |
| Structural/domain view toggle | `UI_REFERENCE` | Useful if semantic candidate status is visually explicit and structural anchors remain one click away. |
| Staleness banner | `UI_REFERENCE` | MAF should expose its richer `CURRENT/STALE/UNKNOWN/CONFLICTED` and provider availability states. |
| Multi-agent file/architecture/tour pipeline | `REJECT` | High orchestration cost is not necessary for MAF's normal path. Semantic work, if ever retained, must be optional, sliced, incremental, and durable. |
| Full graph prompt/chat injection | `REJECT` | Violates Minimum Effective Context and bypasses Context OS. |

`ADAPT` here records a future design constraint, not authorization to change code in Session 8.5.

## N. Overall classification

**DESIGN_REFERENCE_ONLY**

Why not the other classifications:

- `REAL_ADAPTER`: provenance, staleness, scaling, and benchmark evidence are insufficient.
- `MINIMAL_PROTOTYPE`: a prototype before the unseen benchmark would test plumbing rather than the
  unresolved value proposition and would create ecosystem gravity.
- `INTERFACE_SEAM_ONLY`: MAF already has the relevant optional-provider and Context OS pattern; an
  additional unused semantic seam would be speculative.
- `DEFER`: too weak because Session 9 can use UA's interaction evidence now without integrating it.
- `REJECT`: too strong because semantic/domain orientation and UI patterns have legitimate unique
  product value.

## O. Concrete recommendation for Session 9

Session 9 should implement the planned Engineering Control Center as a **derived MAF read model**
and use UA only as interaction research.

Recommended order:

1. Complete the existing Session 9 contract first: one domain-derived read model over health,
   strategy, obligations, trust, mode transitions, context ledger, ProjectBrain, repository modules,
   and optional SCIP status; generate UI types from that contract.
2. Add a Project Map view over MAF-owned data only:
   - path-derived package/module clusters;
   - local deterministic import relationships;
   - optional SCIP symbol/definition/reference/implementation pages;
   - knowledge records separated by `FACT/INFERENCE/EVIDENCE/DECISION`;
   - candidate diff overlay; and
   - visible revision, freshness, completeness, source, and `CONTEXT_ONLY` badges.
3. Borrow overview-to-detail, search, filter, focus, breadcrumb, source detail, path finder, and
   changed/affected overlay primitives.
4. Make every expansion bounded. The UI should request a Context Page/read-model page rather than
   load a whole provider graph.
5. Add fixtures for semantic/domain candidates only as UI state examples; do not generate or ingest
   real UA data in Session 9.
6. Keep guided tours and domain view behind a future benchmark result. If later enabled, show them as
   candidate semantic overlays that resolve to canonical structural anchors.

Session 9 must not add a UA dependency, launch UA agents, read `.ua/knowledge-graph.json`, widen
ProjectBrain FACT semantics, or connect Prompt Compiler to any graph.

## P. Production code before the unseen benchmark

**No production code should be added before the unseen benchmark.**

This includes no adapter, graph importer, domain port, persistence table, background analyzer,
Prompt Compiler path, automatic model/agent stage, or UA-specific UI type. The unseen benchmark must
first show unique task or human value beyond current MAF + SCIP under bounded Context OS conditions.

Documentation and UX research are sufficient now. Avoid ecosystem accumulation.

## Research evidence, limitations, and stop condition

### MAF repository evidence

The authoritative comparison used the current dirty-tree implementation, especially:

- `ARCHITECTURE.md` and `docs/exec-plans/active/selective-ecosystem-capabilities-session-8.md`;
- `src/domain/context.ts` and `src/domain/context-navigation.ts`;
- `src/application/context-navigation.ts` and `src/infrastructure/context-page-source.ts`;
- `src/domain/repository-intelligence.ts` and
  `src/infrastructure/providers/scip-repository-intelligence-adapter.ts`;
- `src/domain/knowledge.ts`, `src/application/project-knowledge.ts`, and
  `src/infrastructure/project-brain.ts`;
- `src/infrastructure/project-brain.ts`'s `LocalRepositoryIndex`; and
- the Session 8 SCIP/Context OS tests.

### Upstream source classes inspected

- exact official `main` checkout at the pinned commit;
- official release and license metadata;
- core graph, Tree-sitter, fingerprint, change, staleness, persistence, search, and diff code;
- skill and agent orchestration instructions;
- dashboard implementation and layout design;
- official issue history for known failures; and
- upstream deterministic benchmark documentation.

No live UA analysis was run against MAF, no model-quality experiment was performed, and no
end-to-end token/cost claim is treated as verified. Issue reports with environment-specific numbers
are labelled anecdotal. No current quantitative evidence was found for semantic/domain precision,
hallucination rate, repeatability, or end-to-end large-repository model cost.

Research stopped when every required A–P decision slot had direct current-code evidence or an
explicitly bounded uncertainty, the highest-impact claims were checked against the pinned checkout,
and further broad issue searching was unlikely to change the integration classification.

## Dirty-tree accounting and validation

- Branch at session start: `adaptive-harness/runtime-signals-v0.1`
- HEAD at session start: `9ff934e53424501098c5dd4da01cfabe987e7d67`
- Pre-session overlay: 151 status entries
- Pre-session status digest: `7ddc122c49c24bc9f1cf06a9fea3096eb8e62592ce7182103c52c3f10d26e9b5`
- Session change: this one new documentation file only
- Production code changed: no
- Reset/clean/stash/checkout/commit/push: none
- `npm run validate`: PASS — formatting, lint, typecheck, 76 test files passed and 4 skipped;
  1,037 tests passed and 8 skipped; server/UI builds, Compose validation, and smoke passed. Lint
  retained the existing 13 warnings and 6 informational suggestions; this session changed none of
  their files.
