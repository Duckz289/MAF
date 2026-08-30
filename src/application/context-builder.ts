import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  type ContextLedgerEntry,
  type ContextSelection,
  type ContextTokenMeter,
  measureContextTokens,
} from "../domain/context";
import {
  createContextHandle,
  createInitialWorkingSet,
  type ContextHandle,
  type ContextHandleTarget,
} from "../domain/context-navigation";
import { knowledgeResolutionBasis, moduleMembershipDigest } from "../domain/knowledge";
import type { RepositoryIntelligenceProvider } from "../domain/repository-intelligence";
import type {
  ContextBuilderPort,
  ContextBuildResult,
  ContextRequest,
  KnowledgeRecord,
  ProjectBrain,
} from "../domain/ports";

const clip = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, Math.max(0, length - 3))}...`;

const resolvedBudget = (requested?: ContextBudget): ContextBudget => {
  if (!requested) return { ...DEFAULT_CONTEXT_BUDGET };
  const result = { ...requested };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Context budget ${key} must be a positive integer`);
    }
  }
  // A request may tighten the default policy but cannot silently turn the builder into an
  // unbounded model-window-sized dump. Raising the architectural ceiling is a code/policy change.
  for (const key of Object.keys(DEFAULT_CONTEXT_BUDGET) as Array<keyof ContextBudget>) {
    result[key] = Math.min(result[key], DEFAULT_CONTEXT_BUDGET[key]);
  }
  return result;
};

const boundedItems = (items: string[], budget: ContextBudget): string[] =>
  items
    .slice(0, budget.maxLedgerItemsPerCategory)
    .map((item) => clip(item, budget.maxItemCharacters));

const ledgerEntry = (
  entry: Omit<ContextLedgerEntry, "estimatedTokens" | "tokenEstimateBasis">,
): ContextLedgerEntry => ({
  ...entry,
  estimatedTokens:
    entry.measuredCharacters === null ? null : Math.ceil(entry.measuredCharacters / 4),
  tokenEstimateBasis: entry.measuredCharacters === null ? "UNKNOWN" : "CHARACTERS_DIVIDED_BY_4",
});

const clipContext = (text: string, maxCharacters: number): { text: string; truncated: boolean } => {
  if (text.length <= maxCharacters) return { text, truncated: false };
  const marker = "\n[Context truncated: character budget reached.]";
  return {
    text: `${text.slice(0, Math.max(0, maxCharacters - marker.length))}${marker}`,
    truncated: true,
  };
};

const safeContextHandle = (
  projectId: string,
  revision: string,
  target: ContextHandleTarget,
): ContextHandle | undefined => {
  try {
    return createContextHandle({ projectId, revision, target });
  } catch {
    // A candidate-controlled path/name that cannot form a canonical locator stays unavailable.
    return undefined;
  }
};

export class GuidedContextBuilder implements ContextBuilderPort {
  constructor(
    private readonly brain: ProjectBrain,
    private readonly tokenMeter?: ContextTokenMeter,
    private readonly repositoryIntelligence?: RepositoryIntelligenceProvider,
  ) {}

  /**
   * Names the existing pager explicitly. This path ranks/selects only; it never renders text or
   * reads ProjectBrain, so RunService can select -> indexScope -> render without throwaway work.
   */
  async selectInitialScope(request: ContextRequest): Promise<ContextSelection> {
    const budget = resolvedBudget(request.budget);
    if (request.mode === "SOLO_NATIVE") {
      return {
        mode: request.mode,
        sourceRevision: request.snapshot.revision,
        modules: [],
        initialFiles: [],
        initialModules: [],
        scannedModules: 0,
        scannedFiles: 0,
        matchedModules: 0,
        truncated: false,
      };
    }

    const taskTerms = new Set(
      request.task.prompt
        .toLowerCase()
        .split(/[^a-z0-9_$-]+/u)
        .filter((term) => term.length >= 3),
    );
    let scannedFiles = 0;
    const rankedModules = Object.entries(request.snapshot.moduleMap)
      .map(([name, files]) => {
        scannedFiles += files.length;
        let score = 0;
        for (const term of taskTerms) {
          if (name.toLowerCase().includes(term)) score += 4;
          for (const file of files) if (file.toLowerCase().includes(term)) score += 1;
        }
        return { name, files, score };
      })
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    const relevantModules = rankedModules.filter((module) => module.score > 0);
    const candidates = relevantModules.length > 0 ? relevantModules : rankedModules;
    const moduleLimit = Math.min(
      budget.maxModules,
      request.mode === "STRICT" ? budget.maxStrictModules : budget.maxModules,
    );
    const modules = candidates.slice(0, moduleLimit).map(({ name, files, score }) => ({
      name,
      files: files.slice(0, budget.maxFilesPerModule),
      score,
    }));
    return {
      mode: request.mode,
      sourceRevision: request.snapshot.revision,
      modules,
      initialFiles: modules.flatMap((module) => module.files),
      initialModules: modules.map((module) => module.name),
      scannedModules: rankedModules.length,
      scannedFiles,
      matchedModules: relevantModules.length,
      truncated:
        candidates.length > modules.length ||
        modules.some(
          (module) =>
            (request.snapshot.moduleMap[module.name]?.length ?? 0) > budget.maxFilesPerModule,
        ),
    };
  }

  async build(request: ContextRequest): Promise<ContextBuildResult> {
    const budget = resolvedBudget(request.budget);
    const stage = request.stage ?? "INITIAL_RENDER";
    const goal = clip(request.task.prompt, budget.maxGoalCharacters);
    const sourceRevision = request.snapshot.revision;

    if (request.mode === "SOLO_NATIVE") {
      const rawText = [
        `Goal: ${goal}`,
        `Revision: ${sourceRevision}`,
        "Native repository search and planning remain fully available.",
      ].join("\n");
      const rendered = clipContext(rawText, budget.maxTextCharacters);
      const tokenMeasurement = measureContextTokens(rendered.text, this.tokenMeter);
      const tokenEstimate = tokenMeasurement.value ?? Math.ceil(rendered.text.length / 4);
      const tokenEstimateBasis =
        tokenMeasurement.precision === "EXACT"
          ? ("EXACT_TOKENIZER" as const)
          : ("CHARACTERS_DIVIDED_BY_4" as const);
      const workingSet = createInitialWorkingSet({
        projectId: request.projectId,
        revision: sourceRevision,
        budget,
        handles: [],
        residentCharacters: rendered.text.length,
      });
      return {
        text: rendered.text,
        evidenceIds: [],
        tokenEstimate,
        tokenEstimateBasis,
        tokenMeasurement,
        initialFiles: [],
        initialModules: [],
        handles: [],
        workingSet,
        evidenceReferencesTruncated: false,
        contextTruncated: rendered.truncated || request.task.prompt.length > goal.length,
        knowledgeRead: { status: "NOT_REQUESTED" },
        ledger: {
          missionId: request.task.id,
          runId: request.runId ?? null,
          projectId: request.projectId,
          buildStage: stage,
          sourceRevision,
          mode: request.mode,
          budget,
          entries: [
            ledgerEntry({
              category: "ORIENTATION",
              source: "TASK",
              reason: "Mission goal and source revision orient the native session.",
              sourceRevision,
              selectedItems: [goal],
              selectedItemCount: 1,
              availableItemCount: 1,
              measuredCharacters: goal.length,
              truncated: request.task.prompt.length > goal.length,
              freshness: "CURRENT",
            }),
            ledgerEntry({
              category: "RENDERED_CONTEXT",
              source: "CONTEXT_POLICY",
              reason: "Final rendered text after the architectural character ceiling.",
              sourceRevision,
              selectedItems: [],
              selectedItemCount: 1,
              availableItemCount: 1,
              measuredCharacters: rendered.text.length,
              truncated: rendered.truncated,
              freshness: "NOT_APPLICABLE",
            }),
          ],
          measuredCharacters: rendered.text.length,
          estimatedTokens: tokenEstimate,
          tokenEstimateBasis,
          tokenMeasurement,
          truncated: rendered.truncated || request.task.prompt.length > goal.length,
          truncationReasons: [
            ...(request.task.prompt.length > goal.length ? ["GOAL_CHARACTER_BUDGET"] : []),
            ...(rendered.truncated ? ["RENDERED_CONTEXT_CHARACTER_BUDGET"] : []),
          ],
          createdAt: new Date().toISOString(),
        },
      };
    }

    const selection = request.selection ?? (await this.selectInitialScope(request));
    if (selection.mode !== request.mode || selection.sourceRevision !== request.snapshot.revision) {
      throw new Error("Context selection does not match the render mode/revision");
    }

    let listedKnowledge: KnowledgeRecord[] = [];
    let knowledgeError: string | undefined;
    let knowledgeResolutionTruncated = false;
    let staleKnowledge = 0;
    let unknownKnowledge = 0;
    let conflictedKnowledge = 0;
    try {
      const resolution = await this.brain.resolveCurrent({
        projectId: request.projectId,
        revision: sourceRevision,
        ...knowledgeResolutionBasis(request.snapshot, selection.initialModules),
        kinds: ["FACT", "DECISION"],
        limit: budget.maxKnowledgeRecords + 1,
      });
      listedKnowledge = resolution.current;
      knowledgeResolutionTruncated = resolution.truncated;
      staleKnowledge = resolution.staleIds.length;
      unknownKnowledge = resolution.unknownIds.length;
      conflictedKnowledge = resolution.conflictedIds.length;
    } catch (error) {
      knowledgeError = error instanceof Error ? error.message : String(error);
    }
    const knowledgePageTruncated =
      knowledgeResolutionTruncated || listedKnowledge.length > budget.maxKnowledgeRecords;
    const knowledge = listedKnowledge.slice(0, budget.maxKnowledgeRecords);
    const selectedFacts = knowledge.slice(0, budget.maxKnowledgeItems);
    const facts = selectedFacts.map(
      (record) => `${record.kind}: ${clip(record.statement, budget.maxItemCharacters)}`,
    );
    const allEvidenceIds = [...new Set(knowledge.flatMap((record) => record.evidenceIds))].sort();
    const evidenceIds = allEvidenceIds.slice(0, budget.maxEvidenceReferences);
    const evidenceReferencesTruncated =
      knowledgePageTruncated || allEvidenceIds.length > evidenceIds.length;

    const initialFileSet = new Set(selection.initialFiles);
    const modules = selection.modules.map(
      ({ name, files }) =>
        `${clip(name, budget.maxItemCharacters)}: ${files
          .map((file) => clip(file, budget.maxItemCharacters))
          .join(", ")}`,
    );
    const eligibleSymbols = request.snapshot.symbols.filter((symbol) =>
      initialFileSet.has(symbol.file),
    );
    const symbolLimit = request.mode === "STRICT" ? budget.maxStrictSymbols : budget.maxSymbols;
    const selectedSymbols = eligibleSymbols.slice(0, symbolLimit);
    const symbols = selectedSymbols.map((symbol) =>
      clip(
        `${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`,
        budget.maxItemCharacters,
      ),
    );
    const evidenceByUri = new Map(
      request.snapshot.evidence.map((entry) => [entry.uri, entry.digest]),
    );
    const repositoryBinding = this.repositoryIntelligence?.bindingFor({
      projectId: request.projectId,
      revision: sourceRevision,
    });
    const repositoryHandle = repositoryBinding
      ? safeContextHandle(request.projectId, sourceRevision, {
          kind: "REPOSITORY",
          sourceId: repositoryBinding.sourceId,
          sourceDigest: repositoryBinding.sourceDigest,
          sourceVersion: repositoryBinding.sourceVersion,
          indexedAt: repositoryBinding.indexedAt,
          completeness: repositoryBinding.completeness,
          languages: repositoryBinding.languages,
        })
      : undefined;
    const handleCandidates: ContextHandle[] = [
      ...(repositoryHandle ? [repositoryHandle] : []),
      ...selection.modules
        .map((module) =>
          safeContextHandle(request.projectId, sourceRevision, {
            kind: "MODULE",
            name: module.name,
            membershipDigest: moduleMembershipDigest(
              module.name,
              request.snapshot.moduleMap[module.name] ?? [],
            ),
          }),
        )
        .filter((handle): handle is ContextHandle => handle !== undefined),
      ...selection.initialFiles
        .map((uri) => {
          const digest = evidenceByUri.get(uri);
          return digest
            ? safeContextHandle(request.projectId, sourceRevision, { kind: "FILE", uri, digest })
            : undefined;
        })
        .filter((handle): handle is ContextHandle => handle !== undefined),
      ...selectedSymbols
        .map((symbol) => {
          const digest = evidenceByUri.get(symbol.file);
          return digest
            ? safeContextHandle(request.projectId, sourceRevision, {
                kind: "SYMBOL",
                uri: symbol.file,
                name: symbol.name,
                line: symbol.line,
                digest,
              })
            : undefined;
        })
        .filter((handle): handle is ContextHandle => handle !== undefined),
      ...selectedFacts
        .map((record) =>
          safeContextHandle(request.projectId, sourceRevision, {
            kind: record.kind === "EVIDENCE" ? "EVIDENCE" : "KNOWLEDGE",
            recordId: record.id,
            knowledgeKind: record.kind,
            sourceDigest: record.provenance.sourceDigest,
          }),
        )
        .filter((handle): handle is ContextHandle => handle !== undefined),
    ];
    const uniqueHandles = [
      ...new Map(handleCandidates.map((handle) => [handle.id, handle])).values(),
    ];
    const boundedHandles = uniqueHandles.slice(0, budget.maxContextHandles);
    const candidateHandleLines = boundedHandles.map(
      (handle) => `${handle.id} ${handle.kind}: ${clip(handle.label, budget.maxItemCharacters)}`,
    );
    const rawText = [
      `Goal: ${goal}`,
      `Mode: ${request.mode}`,
      `Revision: ${sourceRevision}`,
      "This context is a bounded starting point. Native repository search remains available.",
      "Modules:",
      ...modules,
      "Relevant symbols:",
      ...symbols,
      "Context handles (locators only; currency is rechecked on resolution):",
      ...(candidateHandleLines.length > 0
        ? candidateHandleLines
        : ["No resolvable handles in the initial page."]),
      "Current project knowledge (context only; never trust authority):",
      ...(knowledgeError
        ? ["Project knowledge is unavailable for this build."]
        : facts.length > 0
          ? facts
          : ["No current evidence-backed facts recorded for this revision."]),
    ].join("\n");
    const rendered = clipContext(rawText, budget.maxTextCharacters);
    // A handle is resident only if the complete canonical locator survived final prompt clipping.
    // This prevents the Working Set from granting page access through a locator the agent never saw.
    const handles = boundedHandles.filter((handle) => rendered.text.includes(handle.id));
    const handlesTruncated = uniqueHandles.length > handles.length;
    const handleLines = handles.map(
      (handle) => `${handle.id} ${handle.kind}: ${clip(handle.label, budget.maxItemCharacters)}`,
    );
    const tokenMeasurement = measureContextTokens(rendered.text, this.tokenMeter);
    const tokenEstimate = tokenMeasurement.value ?? Math.ceil(rendered.text.length / 4);
    const tokenEstimateBasis =
      tokenMeasurement.precision === "EXACT"
        ? ("EXACT_TOKENIZER" as const)
        : ("CHARACTERS_DIVIDED_BY_4" as const);
    const knowledgeItemsTruncated = knowledge.length > selectedFacts.length;
    const symbolsTruncated = eligibleSymbols.length > symbols.length;
    const goalTruncated = request.task.prompt.length > goal.length;
    const truncationReasons = [
      ...(goalTruncated ? ["GOAL_CHARACTER_BUDGET"] : []),
      ...(selection.truncated ? ["MODULE_OR_FILE_CARDINALITY_BUDGET"] : []),
      ...(symbolsTruncated ? ["SYMBOL_CARDINALITY_BUDGET"] : []),
      ...(knowledgePageTruncated ? ["KNOWLEDGE_QUERY_BUDGET"] : []),
      ...(knowledgeItemsTruncated ? ["KNOWLEDGE_RENDER_BUDGET"] : []),
      ...(evidenceReferencesTruncated ? ["EVIDENCE_REFERENCE_BUDGET"] : []),
      ...(handlesTruncated ? ["CONTEXT_HANDLE_BUDGET"] : []),
      ...(rendered.truncated ? ["RENDERED_CONTEXT_CHARACTER_BUDGET"] : []),
    ];

    const entries: ContextLedgerEntry[] = [
      ledgerEntry({
        category: "ORIENTATION",
        source: "TASK",
        reason: "Mission goal and source revision orient the bounded starting context.",
        sourceRevision,
        selectedItems: [goal],
        selectedItemCount: 1,
        availableItemCount: 1,
        measuredCharacters: goal.length,
        truncated: goalTruncated,
        freshness: "CURRENT",
      }),
      ledgerEntry({
        category: "MODULES",
        source: "REPOSITORY_INDEX",
        reason: `Existing pager ranked ${selection.scannedModules} modules from task/path matches.`,
        sourceRevision: request.snapshot.revision,
        selectedItems: boundedItems(selection.initialModules, budget),
        selectedItemCount: selection.initialModules.length,
        availableItemCount: selection.scannedModules,
        measuredCharacters: modules.join("\n").length,
        truncated: selection.truncated,
        freshness: "CURRENT",
      }),
      ledgerEntry({
        category: "FILES",
        source: "REPOSITORY_INDEX",
        reason: "Selected module pages supply the bounded files parsed for initial context.",
        sourceRevision: request.snapshot.revision,
        selectedItems: boundedItems(selection.initialFiles, budget),
        selectedItemCount: selection.initialFiles.length,
        availableItemCount: selection.scannedFiles,
        measuredCharacters: selection.initialFiles.join("\n").length,
        truncated: selection.truncated,
        freshness: "CURRENT",
      }),
      ledgerEntry({
        category: "SYMBOLS",
        source: "REPOSITORY_INDEX",
        reason: "Only symbols from the selected, digest-indexed file page are rendered.",
        sourceRevision: request.snapshot.revision,
        selectedItems: boundedItems(symbols, budget),
        selectedItemCount: symbols.length,
        availableItemCount: eligibleSymbols.length,
        measuredCharacters: symbols.join("\n").length,
        truncated: symbolsTruncated,
        freshness: "CURRENT",
      }),
      ledgerEntry({
        category: "KNOWLEDGE",
        source: "PROJECT_BRAIN",
        reason: knowledgeError
          ? "ProjectBrain read failed; no stored statement was treated as current authority."
          : `Only source-revalidated FACT/DECISION records enter the page; rejected stale=${staleKnowledge}, unknown=${unknownKnowledge}, conflicted=${conflictedKnowledge}.`,
        sourceRevision,
        selectedItems: boundedItems(facts, budget),
        selectedItemCount: facts.length,
        availableItemCount: knowledgeError || knowledgePageTruncated ? null : knowledge.length,
        measuredCharacters: knowledgeError ? 0 : facts.join("\n").length,
        truncated: knowledgePageTruncated || knowledgeItemsTruncated,
        freshness: knowledgeError ? "UNKNOWN" : "CURRENT",
      }),
      ledgerEntry({
        category: "HANDLES",
        source: "CONTEXT_POLICY",
        reason:
          "Canonical locators carry no payload or trust authority and must be revalidated when resolved.",
        sourceRevision,
        selectedItems: boundedItems(
          handles.map((handle) => `${handle.id} ${handle.kind} ${handle.label}`),
          budget,
        ),
        selectedItemCount: handles.length,
        availableItemCount: uniqueHandles.length,
        measuredCharacters: handleLines.join("\n").length,
        truncated: handlesTruncated,
        freshness: "NOT_APPLICABLE",
      }),
      ledgerEntry({
        category: "EVIDENCE_REFERENCES",
        source: "PROJECT_BRAIN",
        reason: "References are deduplicated and capped independently of stored knowledge growth.",
        sourceRevision,
        selectedItems: boundedItems(evidenceIds, budget),
        selectedItemCount: evidenceIds.length,
        availableItemCount: knowledgeError || knowledgePageTruncated ? null : allEvidenceIds.length,
        measuredCharacters: evidenceIds.join("\n").length,
        truncated: evidenceReferencesTruncated,
        freshness: knowledgeError ? "UNKNOWN" : "CURRENT",
      }),
      ledgerEntry({
        category: "RENDERED_CONTEXT",
        source: "CONTEXT_POLICY",
        reason: "Final rendered text after the architectural character ceiling.",
        sourceRevision,
        selectedItems: [],
        selectedItemCount: 1,
        availableItemCount: 1,
        measuredCharacters: rendered.text.length,
        truncated: rendered.truncated,
        freshness: "NOT_APPLICABLE",
      }),
    ];

    const workingSet = createInitialWorkingSet({
      projectId: request.projectId,
      revision: sourceRevision,
      budget,
      handles,
      residentCharacters: rendered.text.length,
    });

    return {
      text: rendered.text,
      evidenceIds,
      tokenEstimate,
      tokenEstimateBasis,
      tokenMeasurement,
      initialFiles: selection.initialFiles,
      initialModules: selection.initialModules,
      handles,
      workingSet,
      evidenceReferencesTruncated,
      contextTruncated: truncationReasons.length > 0,
      knowledgeRead: knowledgeError
        ? { status: "UNAVAILABLE", error: knowledgeError }
        : {
            status: "AVAILABLE",
            stale: staleKnowledge,
            unknown: unknownKnowledge,
            conflicted: conflictedKnowledge,
          },
      ledger: {
        missionId: request.task.id,
        runId: request.runId ?? null,
        projectId: request.projectId,
        buildStage: stage,
        sourceRevision,
        mode: request.mode,
        budget,
        entries,
        measuredCharacters: rendered.text.length,
        estimatedTokens: tokenEstimate,
        tokenEstimateBasis,
        tokenMeasurement,
        truncated: truncationReasons.length > 0,
        truncationReasons,
        createdAt: new Date().toISOString(),
      },
    };
  }
}
