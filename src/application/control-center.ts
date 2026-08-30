import { existsSync } from "node:fs";
import { type ContextBudget, DEFAULT_CONTEXT_BUDGET } from "../domain/context";
import {
  type AdvancedMissionReadModel,
  boundPageLimit,
  type CandidateInspection,
  type CheckOutcomeStatus,
  CONTROL_CENTER_PAGE,
  type ContextInspection,
  type ControlCenterOverview,
  type CostPresentation,
  checkOutcomeLabel,
  checkOutcomeTone,
  deriveWhyRecords,
  type EventInspection,
  type EvidenceInspection,
  type EvolutionInspection,
  type InspectionDepth,
  type InspectMissionReadModel,
  type KnowledgeInspectionRecord,
  type KnowledgeSummary,
  knowledgeVisualAuthority,
  type MissionReadModel,
  type ObligationInspection,
  type OptionalProviderStatus,
  type PageQuery,
  type PageResult,
  type ProjectMapEdge,
  type ProjectMapNode,
  type ProjectMapReadModel,
  type ProjectSummaryReadModel,
  paginateItems,
  presentCostBreakdown,
  type SimpleMissionReadModel,
  type TrustDerivationStep,
} from "../domain/control-center";
import { classifyKnowledgeRecords, knowledgeResolutionBasis } from "../domain/knowledge";
import type { KnowledgeRecord, ProjectBrain, RepositoryIndex, RunStore } from "../domain/ports";
import type { RepositoryIntelligenceProvider } from "../domain/repository-intelligence";
import { redactSensitiveData } from "../domain/security";
import type { Artifact, Event, Run, Task, TrustState, Verification } from "../domain/types";
import type { WorkItem, WorkItemMutation, WorkItemProvider } from "../domain/work";
import type { CapabilityRegistry } from "./capability-registry";
import type { MissionRegistry } from "./mission-registry";
import type { InMemoryProjectRegistry } from "./project-registry";

export interface ControlCenterDependencies {
  store: RunStore;
  projects: InMemoryProjectRegistry;
  missions: MissionRegistry;
  projectBrain: ProjectBrain;
  repositoryIndex: RepositoryIndex;
  capabilities: CapabilityRegistry;
  workItems: WorkItemProvider;
  optionalProviders: OptionalProviderStatus[];
  repositoryIntelligence?: RepositoryIntelligenceProvider;
  emergencyStop?: () => boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const preview = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

const emptyKnowledge = (): KnowledgeSummary => ({
  examined: 0,
  current: 0,
  stale: 0,
  unknown: 0,
  conflicted: 0,
  truncated: false,
});

const trustLabel = (state: TrustState | "UNKNOWN"): string => {
  switch (state) {
    case "MERGE_ELIGIBLE":
      return "Merge eligible";
    case "DURABLE_VERIFIED":
      return "Durable verified";
    case "QUALITY_VERIFIED":
      return "Quality verified";
    case "CORRECTNESS_VERIFIED":
      return "Correctness verified";
    case "PROPOSED":
      return "Proposed — not executed";
    default:
      return "Unknown";
  }
};

const matchProject = (projects: InMemoryProjectRegistry, repositoryPath: string) =>
  projects.list().find((project) => project.repositoryPath === repositoryPath);

export const describeOptionalProviders = (input: {
  dependencyScannerEnabled: boolean;
  dependencyScannerCommand: boolean;
  staticAnalysisEnabled: boolean;
  staticAnalysisConfigured: boolean;
  repositoryIntelligenceConfigured: boolean;
  otlpEnabled: boolean;
  pricingConfigured: boolean;
}): OptionalProviderStatus[] => [
  {
    id: "dependency-vulnerability",
    name: "Dependency vulnerability scanner",
    kind: "DEPENDENCY_VULNERABILITY",
    availability:
      input.dependencyScannerEnabled && input.dependencyScannerCommand
        ? "AVAILABLE"
        : input.dependencyScannerEnabled
          ? "FAILED"
          : "NOT_CONFIGURED",
    version: null,
    scope: "Changed lockfiles; exact positive findings only",
    lastExecution: null,
    failure:
      input.dependencyScannerEnabled && !input.dependencyScannerCommand
        ? "enabled without an executable path"
        : null,
    coverageLimitations: [
      "silence is not absence",
      "dependency inventory is not source-language coverage",
    ],
    systemHealthImpact: "NONE",
  },
  {
    id: "static-analysis",
    name: "Static analysis scanner",
    kind: "STATIC_ANALYSIS",
    availability:
      input.staticAnalysisEnabled && input.staticAnalysisConfigured
        ? "AVAILABLE"
        : input.staticAnalysisEnabled
          ? "FAILED"
          : "NOT_CONFIGURED",
    version: null,
    scope: "Operator-supplied intrafile rules; positive findings only",
    lastExecution: null,
    failure:
      input.staticAnalysisEnabled && !input.staticAnalysisConfigured
        ? "enabled without complete local rules configuration"
        : null,
    coverageLimitations: [
      "clean output has no negative-absence authority",
      "interfile analysis excluded",
    ],
    systemHealthImpact: "NONE",
  },
  {
    id: "repository-intelligence",
    name: "Repository intelligence",
    kind: "REPOSITORY_INTELLIGENCE",
    availability: input.repositoryIntelligenceConfigured ? "AVAILABLE" : "NOT_CONFIGURED",
    version: null,
    scope: "Bounded symbol/definition/reference/implementation pages",
    lastExecution: null,
    failure: null,
    coverageLimitations: [
      "navigation only; CONTEXT_ONLY authority",
      "graph edges are not trust evidence",
    ],
    systemHealthImpact: "NONE",
  },
  {
    id: "otlp",
    name: "OTLP trace export",
    kind: "OBSERVABILITY_EXPORT",
    availability: input.otlpEnabled ? "AVAILABLE" : "NOT_CONFIGURED",
    version: null,
    scope: "Allowlisted capability-execution summaries",
    lastExecution: null,
    failure: null,
    coverageLimitations: ["export failure does not affect run trust or merge eligibility"],
    systemHealthImpact: "NONE",
  },
  {
    id: "model-pricing-catalog",
    name: "Model pricing catalog",
    kind: "MODEL_PRICING",
    availability: input.pricingConfigured ? "AVAILABLE" : "NOT_CONFIGURED",
    version: null,
    scope: "Offline operator-supplied price table; ESTIMATE only",
    lastExecution: null,
    failure: null,
    coverageLimitations: [
      "missing price is UNKNOWN, never $0",
      "native subscription execution is not API usage",
    ],
    systemHealthImpact: "NONE",
  },
];

export class ControlCenterService {
  constructor(private readonly dependencies: ControlCenterDependencies) {}

  async overview(): Promise<ControlCenterOverview> {
    const [runs, projects] = await Promise.all([
      this.dependencies.store.listRuns(),
      Promise.resolve(this.dependencies.projects.list()),
    ]);
    const missionTrees = this.dependencies.missions.list().length;
    const attention = runs.filter(
      (run) =>
        run.state === "FAILED" ||
        run.state === "PAUSED" ||
        run.verificationState === "QUARANTINED" ||
        (run.verificationState === "VERIFIED" && run.trustState !== "MERGE_ELIGIBLE"),
    ).length;
    const knowledge = projects[0]
      ? await this.knowledgeSummary(projects[0].id, projects[0].revision)
      : emptyKnowledge();
    const knownCosts = runs.map((run) => presentCostBreakdown(run.cost));
    const knownSubtotalUsd = knownCosts.reduce((sum, cost) => sum + cost.knownSubtotalUsd, 0);
    const unknownComponentCount = knownCosts.reduce(
      (sum, cost) => sum + cost.unknownComponentCount,
      0,
    );
    const cost: CostPresentation =
      knownCosts.length === 0
        ? presentCostBreakdown({
            model: 0,
            sandbox: 0,
            verification: 0,
            retry: 0,
            recovery: 0,
            total: 0,
          })
        : {
            total:
              unknownComponentCount > 0
                ? {
                    status: "UNKNOWN",
                    amountUsd: null,
                    display: "unknown",
                    source: "one or more runs have unknown monetary cost",
                  }
                : {
                    status: "ESTIMATED",
                    amountUsd: knownSubtotalUsd,
                    display: `~$${knownSubtotalUsd.toFixed(2)}`,
                    source: "sum of recorded run ledgers",
                  },
            knownSubtotalUsd,
            unknownComponentCount,
            components: [],
            costPerDurableVerifiedSuccess: null,
          };
    return {
      product: "ENGINEERING_CONTROL_CENTER",
      emergencyStop: this.dependencies.emergencyStop?.() === true,
      projects: projects.length,
      missionTrees,
      activeRuns: runs.filter((run) => run.state === "RUNNING" || run.state === "QUEUED").length,
      attention,
      knowledge,
      cost,
      providers: await this.providerStatus(),
    };
  }

  providers(): OptionalProviderStatus[] {
    return this.dependencies.optionalProviders.map((provider) => structuredClone(provider));
  }

  async providerStatus(): Promise<OptionalProviderStatus[]> {
    const listed = this.providers();
    const ids = this.dependencies.capabilities.capabilityIds();
    const resolutions = (
      await Promise.all(ids.map((id) => this.dependencies.capabilities.resolveWithStatus(id)))
    ).flat();
    return listed.map((provider) => {
      const match = resolutions.find(
        (resolution) =>
          provider.id.includes(resolution.selectedProviderName) ||
          resolution.selectedProviderName.includes(provider.id),
      );
      if (!match) return provider;
      return {
        ...provider,
        version: match.probe.version,
        availability: match.probe.available ? "AVAILABLE" : "UNAVAILABLE",
        failure: match.probe.available ? null : match.probe.detail,
        systemHealthImpact: "NONE",
      };
    });
  }

  async projectSummary(projectId: string): Promise<ProjectSummaryReadModel | undefined> {
    const project = this.dependencies.projects.get(projectId);
    if (!project) return undefined;
    const runs = await this.runsForRepository(project.repositoryPath);
    return {
      id: project.id,
      name: project.name,
      revision: project.revision,
      repositoryPresent: existsSync(project.repositoryPath),
      activeRuns: runs.filter((run) => run.state === "RUNNING" || run.state === "QUEUED").length,
      blockedRuns: runs.filter(
        (run) =>
          run.state === "PAUSED" ||
          run.state === "FAILED" ||
          (run.verificationState === "VERIFIED" && run.trustState !== "MERGE_ELIGIBLE"),
      ).length,
      knowledge: await this.knowledgeSummary(project.id, project.revision),
      providers: this.providers(),
    };
  }

  async projectKnowledge(
    projectId: string,
    query: PageQuery & { kind?: KnowledgeRecord["kind"] } = {},
  ): Promise<PageResult<KnowledgeInspectionRecord> | undefined> {
    const project = this.dependencies.projects.get(projectId);
    if (!project) return undefined;
    const kinds = query.kind ? [query.kind] : undefined;
    const basis = await this.liveKnowledgeBasis(project.id, project.revision);
    const resolved = await this.dependencies.projectBrain.resolveCurrent({
      projectId: project.id,
      revision: project.revision,
      ...basis,
      ...(kinds ? { kinds } : {}),
      limit: CONTROL_CENTER_PAGE.knowledgePage,
    });
    const currentItems: KnowledgeInspectionRecord[] = resolved.current.map((record) => ({
      id: record.id,
      kind: record.kind,
      statement: record.statement,
      resolution: "CURRENT",
      authority: knowledgeVisualAuthority(record.kind, "CURRENT"),
      producer: record.provenance.producer,
      source: record.provenance.source,
      revision: record.revision,
      evidenceIds: record.evidenceIds,
    }));
    const withheld = (
      ids: string[],
      resolution: KnowledgeInspectionRecord["resolution"],
    ): KnowledgeInspectionRecord[] =>
      ids.map((id) => ({
        id,
        kind: "EVIDENCE",
        statement: `Record ${id} is ${resolution} and withheld from current fact rendering`,
        resolution,
        authority: knowledgeVisualAuthority("FACT", resolution),
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
        revision: project.revision,
        evidenceIds: [],
      }));
    const items = [
      ...currentItems,
      ...withheld(resolved.staleIds, "STALE"),
      ...withheld(resolved.conflictedIds, "CONFLICTED"),
      ...withheld(resolved.unknownIds, "UNKNOWN"),
    ];
    return paginateItems(items, query);
  }

  async projectMap(
    projectId: string,
    query: PageQuery & {
      search?: string;
      focus?: string;
      neighborhood?: boolean;
    } = {},
  ): Promise<ProjectMapReadModel | undefined> {
    const project = this.dependencies.projects.get(projectId);
    if (!project) return undefined;
    const knowledge = await this.knowledgeSummary(project.id, project.revision);
    const emptyNeighborhood = {
      available: this.dependencies.repositoryIntelligence !== undefined,
      status: "NOT_REQUESTED" as const,
      reason: "Neighborhood queries are opt-in and page-bounded",
      truncated: false,
    };
    if (!existsSync(project.repositoryPath)) {
      return {
        projectId: project.id,
        revision: project.revision,
        source: "REPOSITORY_INDEX",
        focus: query.focus ?? null,
        nodes: [],
        edges: [],
        knowledge,
        truncated: false,
        nextCursor: null,
        filesTruncated: false,
        neighborhood: {
          ...emptyNeighborhood,
          status: "UNAVAILABLE",
          reason: "Repository path is not available on this host",
        },
      };
    }
    const snapshot = await this.dependencies.repositoryIndex.index(
      project.repositoryPath,
      project.revision,
    );
    const search = query.search?.trim().toLowerCase() ?? "";
    const moduleNames = Object.keys(snapshot.moduleMap)
      .sort((left, right) => left.localeCompare(right))
      .filter((name) => search.length === 0 || name.toLowerCase().includes(search));
    const page = paginateItems(moduleNames, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: Math.min(boundPageLimit(query.limit), CONTROL_CENTER_PAGE.mapModules),
    });
    const projectRuns = await this.runsForRepository(project.repositoryPath);
    const changed = new Set(projectRuns.flatMap((run) => run.changedFiles));
    const failedFiles = new Set(
      projectRuns
        .filter((run) => run.state === "FAILED" || run.verificationState === "QUARANTINED")
        .flatMap((run) => run.changedFiles),
    );
    const knowledgeRecords = await this.dependencies.projectBrain.list(
      project.id,
      project.revision,
      undefined,
      CONTROL_CENTER_PAGE.knowledgePage,
    );
    const knowledgeStates = classifyKnowledgeRecords(knowledgeRecords, {
      projectId: project.id,
      revision: project.revision,
      ...(await this.liveKnowledgeBasis(project.id, project.revision)),
    });
    const nodes: ProjectMapNode[] = [];
    const edges: ProjectMapEdge[] = [];
    for (const moduleName of page.items) {
      const files = (snapshot.moduleMap[moduleName] ?? []).slice(
        0,
        CONTROL_CENTER_PAGE.mapFilesPerModule,
      );
      const moduleFlags: ProjectMapNode["flags"] = [];
      if (files.some((file) => changed.has(file))) moduleFlags.push("CHANGED", "ACTIVE_MISSION");
      if (files.some((file) => failedFiles.has(file))) moduleFlags.push("RECENT_FAILURE");
      const moduleKnowledge = knowledgeRecords.filter(
        (record) => record.scope?.kind === "MODULE" && record.scope.identity === moduleName,
      );
      if (moduleKnowledge.some((record) => knowledgeStates.get(record.id) === "STALE")) {
        moduleFlags.push("STALE_KNOWLEDGE");
      }
      if (moduleKnowledge.some((record) => knowledgeStates.get(record.id) === "CONFLICTED")) {
        moduleFlags.push("CONFLICTED_KNOWLEDGE");
      }
      nodes.push({
        id: `module:${moduleName}`,
        kind: "MODULE",
        label: moduleName,
        path: moduleName,
        authority: "DETERMINISTIC_STRUCTURE",
        flags: [...new Set(moduleFlags)],
        childCount: (snapshot.moduleMap[moduleName] ?? []).length,
      });
      for (const file of files) {
        const fileFlags: ProjectMapNode["flags"] = [];
        if (changed.has(file)) fileFlags.push("CHANGED", "ACTIVE_MISSION");
        if (failedFiles.has(file)) fileFlags.push("RECENT_FAILURE");
        nodes.push({
          id: `file:${file}`,
          kind: "FILE",
          label: file,
          path: file,
          authority: "DETERMINISTIC_STRUCTURE",
          flags: fileFlags,
          childCount: 0,
        });
        edges.push({
          from: `module:${moduleName}`,
          to: `file:${file}`,
          kind: "CONTAINS",
          authority: "DETERMINISTIC_STRUCTURE",
          trustAuthority: "NONE",
        });
      }
    }

    const focus = query.focus?.trim();
    if (focus && snapshot.moduleMap[focus]) {
      const focusFiles = (snapshot.moduleMap[focus] ?? []).slice(
        0,
        CONTROL_CENTER_PAGE.mapScopeFiles,
      );
      const scoped = await this.dependencies.repositoryIndex.indexScope(
        project.repositoryPath,
        project.revision,
        snapshot,
        focusFiles,
      );
      for (const relation of scoped.relations.slice(0, CONTROL_CENTER_PAGE.mapRelations)) {
        edges.push({
          from: `file:${relation.from}`,
          to: `file:${relation.to}`,
          kind: relation.kind === "IMPORTS" ? "IMPORTS" : "REFERENCES",
          authority: "DETERMINISTIC_STRUCTURE",
          trustAuthority: "NONE",
        });
      }
      for (const symbol of scoped.symbols.slice(0, CONTROL_CENTER_PAGE.mapNeighborhood)) {
        nodes.push({
          id: `symbol:${symbol.file}:${symbol.name}:${symbol.line}`,
          kind: "SYMBOL",
          label: symbol.name,
          path: symbol.file,
          authority: "DETERMINISTIC_STRUCTURE",
          flags: changed.has(symbol.file) ? ["CHANGED"] : [],
          childCount: 0,
        });
      }
    }

    let neighborhood: ProjectMapReadModel["neighborhood"] = emptyNeighborhood;
    if (query.neighborhood === true) {
      const provider = this.dependencies.repositoryIntelligence;
      if (!provider) {
        neighborhood = {
          available: false,
          status: "UNAVAILABLE",
          reason: "Repository intelligence provider is not configured",
          truncated: false,
        };
      } else if (!focus) {
        neighborhood = {
          available: true,
          status: "NOT_REQUESTED",
          reason: "A focus module is required for bounded neighborhood queries",
          truncated: false,
        };
      } else {
        const result = await provider.query({
          operation: "FIND_REFERENCES",
          repositoryPath: project.repositoryPath,
          projectId: project.id,
          revision: project.revision,
          maxResults: CONTROL_CENTER_PAGE.mapNeighborhood,
          query: focus,
        });
        neighborhood = {
          available: true,
          status: result.status === "COMPLETED" ? "BOUNDED" : "FAILED",
          reason: result.reason,
          truncated: result.truncated,
        };
        for (const location of result.locations) {
          nodes.push({
            id: `intel:${location.uri}:${location.name}:${location.range.startLine}`,
            kind: "SYMBOL",
            label: location.name,
            path: location.uri,
            authority: "CONTEXT_ONLY",
            flags: [],
            childCount: 0,
          });
        }
      }
    }

    for (const record of knowledgeRecords.slice(0, 12)) {
      const resolution = knowledgeStates.get(record.id) ?? "UNKNOWN";
      nodes.push({
        id: `knowledge:${record.id}`,
        kind: "KNOWLEDGE",
        label: record.statement.slice(0, 80),
        path: record.scope?.identity ?? null,
        authority: knowledgeVisualAuthority(record.kind, resolution),
        flags:
          resolution === "STALE"
            ? ["STALE_KNOWLEDGE"]
            : resolution === "CONFLICTED"
              ? ["CONFLICTED_KNOWLEDGE"]
              : [],
        childCount: 0,
      });
    }

    return {
      projectId: project.id,
      revision: snapshot.revision,
      source: "REPOSITORY_INDEX",
      focus: focus ?? null,
      nodes,
      edges,
      knowledge,
      truncated: page.truncated || snapshot.filesTruncated,
      nextCursor: page.nextCursor,
      filesTruncated: snapshot.filesTruncated,
      neighborhood,
    };
  }

  async mission(
    runId: string,
    depth: InspectionDepth = "SIMPLE",
  ): Promise<MissionReadModel | undefined> {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const task = await this.dependencies.store.getTask(run.taskId);
    const events = await this.dependencies.store.listEvents(run.id);
    const verifications = await this.dependencies.store.listVerifications(run.id);
    const artifacts = await this.dependencies.store.listArtifacts(run.id);
    const simple = this.simpleMission(run, task, verifications);
    if (depth === "SIMPLE") return simple;
    const advanced = await this.advancedMission(simple, run, events, verifications);
    if (depth === "ADVANCED") return advanced;
    return this.inspectMission(advanced, run, task, events, verifications, artifacts);
  }

  async events(
    runId: string,
    query: PageQuery = {},
  ): Promise<PageResult<EventInspection> | undefined> {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const events = await this.dependencies.store.listEvents(run.id);
    const items: EventInspection[] = [...events].reverse().map((event) => ({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      summary: preview(redactSensitiveData(event.data), CONTROL_CENTER_PAGE.eventPreviewChars),
    }));
    return paginateItems(items, query);
  }

  async evidence(
    runId: string,
    query: PageQuery = {},
  ): Promise<PageResult<EvidenceInspection> | undefined> {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const [events, verifications, snapshots] = await Promise.all([
      this.dependencies.store.listEvents(run.id),
      this.dependencies.store.listVerifications(run.id),
      this.dependencies.store.listSignalSnapshots(run.id),
    ]);
    const items: EvidenceInspection[] = [];
    for (const verification of verifications) {
      items.push({
        id: verification.id,
        kind: "VERIFICATION",
        status: verification.state,
        tone: checkOutcomeTone(verification.state),
        summary: preview(
          redactSensitiveData(verification.output),
          CONTROL_CENTER_PAGE.evidencePreviewChars,
        ),
        authority:
          verification.state === "VERIFIED" &&
          verification.environment &&
          verification.authority?.authorized === true
            ? "VERIFIED"
            : verification.state === "VERIFIED"
              ? "DETERMINISTIC"
              : "UNKNOWN",
      });
    }
    for (const event of events) {
      if (event.type !== "QualityAssessed") continue;
      const data = asRecord(event.data);
      const obligations = Array.isArray(data.obligations) ? data.obligations : [];
      for (const obligation of obligations) {
        const row = asRecord(obligation);
        const status = (asString(row.status) ?? "UNKNOWN") as CheckOutcomeStatus;
        items.push({
          id: asString(row.id) ?? `obligation-${event.id}`,
          kind: "OBLIGATION",
          status,
          tone: checkOutcomeTone(status),
          summary: asString(row.justification) ?? asString(row.id) ?? "obligation",
          // A PASS is authority for this one obligation/check only, not verifier authority over
          // the whole candidate.
          authority: status === "UNKNOWN" ? "UNKNOWN" : "DETERMINISTIC",
        });
      }
    }
    for (const snapshot of snapshots.slice(-8)) {
      items.push({
        id: snapshot.id,
        kind: "RUNTIME_SIGNAL",
        status: "RECORDED",
        tone: "informative",
        summary: `Signal snapshot ${snapshot.id}`,
        authority: "DETERMINISTIC",
      });
    }
    return paginateItems(items, query);
  }

  async trust(runId: string): Promise<
    | {
        candidate: CandidateInspection | null;
        verification: { state: string; executed: boolean };
        obligations: ObligationInspection[];
        derivation: TrustDerivationStep[];
        trustState: TrustState | "UNKNOWN";
      }
    | undefined
  > {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const [events, verifications, artifacts] = await Promise.all([
      this.dependencies.store.listEvents(run.id),
      this.dependencies.store.listVerifications(run.id),
      this.dependencies.store.listArtifacts(run.id),
    ]);
    const candidate = this.candidateFrom(artifacts);
    const latestVerification = verifications.at(-1);
    const obligations = this.obligationsFrom(events);
    return {
      candidate,
      verification: {
        state: latestVerification?.state ?? "NOT_EXECUTED",
        executed: latestVerification !== undefined,
      },
      obligations,
      derivation: this.trustDerivation(run, candidate, latestVerification, obligations),
      trustState: run.trustState ?? "UNKNOWN",
    };
  }

  async context(runId: string): Promise<ContextInspection | undefined> {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const events = await this.dependencies.store.listEvents(run.id);
    return this.contextFrom(events);
  }

  async why(runId: string): Promise<ReturnType<typeof deriveWhyRecords> | undefined> {
    const run = await this.dependencies.store.getRun(runId);
    if (!run) return undefined;
    const events = await this.dependencies.store.listEvents(run.id);
    return deriveWhyRecords(events);
  }

  async evolution(): Promise<EvolutionInspection> {
    const observations = await this.dependencies.store.listStrategyObservations(undefined, 20);
    const latest = observations.at(-1);
    const challenger = observations.find(
      (observation) => observation.strategy.baseline === "CHALLENGER",
    );
    return {
      productionBaseline: latest
        ? {
            id: latest.strategy.adapter,
            class: latest.scope.taskClass,
            version: latest.timestamp,
          }
        : null,
      challenger: challenger
        ? {
            id: challenger.strategy.adapter,
            class: challenger.scope.taskClass,
            lifecycle: challenger.source === "BENCHMARK_SHADOW" ? "SHADOW" : "CANDIDATE",
          }
        : null,
      evaluationLineage: observations.map((observation) => ({
        id: observation.id,
        stage: observation.evidenceBasis,
        result: "NOT_EVALUATED",
      })),
      frozenSuite: null,
      shadowStatus: "NOT_RUNNING",
      promotion: "NONE_RECORDED",
      optimizeProductionPolicyAvailable: false,
    };
  }

  async workItems(
    projectId: string | undefined,
    query: PageQuery = {},
  ): Promise<PageResult<WorkItem>> {
    const items = await this.dependencies.workItems.list(projectId);
    return paginateItems(items, query);
  }

  async applyWorkItem(mutation: WorkItemMutation): Promise<WorkItem> {
    return this.dependencies.workItems.apply(mutation);
  }

  private simpleMission(
    run: Run,
    task: Task | undefined,
    verifications: Verification[],
  ): SimpleMissionReadModel {
    const trustState = run.trustState ?? "UNKNOWN";
    const latest = verifications.at(-1);
    const project = task
      ? matchProject(this.dependencies.projects, task.repositoryPath)
      : undefined;
    return {
      depth: "SIMPLE",
      runId: run.id,
      projectId: project?.id ?? null,
      objective: task?.prompt ?? "Unknown objective",
      status: run.state,
      operationalStatus: run.state,
      selectedAgent: run.agent,
      selectedModel: run.model,
      interventionMode: run.effectiveMode,
      budget: {
        mode: task?.budget?.mode ?? "ADVISORY",
        configured: task?.budget !== undefined,
        limitUsd: task?.budget?.limitUsd ?? null,
      },
      cost: presentCostBreakdown(run.cost),
      verification: {
        state: latest?.state ?? "NOT_EXECUTED",
        label: checkOutcomeLabel(latest?.state ?? "NOT_EXECUTED"),
        tone: checkOutcomeTone(latest?.state ?? "NOT_EXECUTED"),
      },
      trust: {
        state: trustState,
        label: trustLabel(trustState),
        tone: checkOutcomeTone(trustState === "UNKNOWN" ? "UNKNOWN" : trustState),
      },
    };
  }

  private async advancedMission(
    simple: SimpleMissionReadModel,
    run: Run,
    events: Event<unknown>[],
    verifications: Verification[],
  ): Promise<AdvancedMissionReadModel> {
    const skillEvent = [...events].reverse().find((event) => event.type === "AgentSkillsSelected");
    const riskEvent = [...events].reverse().find((event) => event.type === "RiskProfiled");
    const skills = Array.isArray(asRecord(skillEvent?.data).selections)
      ? (asRecord(skillEvent?.data).selections as unknown[]).map((selection) => {
          const row = asRecord(selection);
          return {
            skillId: asString(row.skillId) ?? "unknown",
            status: asString(row.status) ?? "UNKNOWN",
            reason: asString(row.reason) ?? "no recorded reason",
          };
        })
      : [];
    const riskVector = asRecord(asRecord(riskEvent?.data).riskVector);
    const coupling = asRecord(riskVector.CodeCoupling);
    return {
      ...simple,
      depth: "ADVANCED",
      desiredMode: run.desiredMode,
      effectiveMode: run.effectiveMode,
      skills,
      risk:
        Object.keys(riskVector).length > 0
          ? Object.fromEntries(
              Object.entries(riskVector).map(([name, value]) => {
                const row = asRecord(value);
                return [
                  name,
                  {
                    level: asString(row.level) ?? "UNKNOWN",
                    provenance: asString(row.provenance) ?? "INSUFFICIENT_EVIDENCE",
                  },
                ];
              }),
            )
          : null,
      coupling:
        Object.keys(coupling).length > 0
          ? {
              level: asString(coupling.level) ?? "UNKNOWN",
              provenance: asString(coupling.provenance) ?? "INSUFFICIENT_EVIDENCE",
            }
          : null,
      strategy: {
        binding: run.strategyObservationBinding?.id ?? null,
        observationId: run.strategyObservationBinding?.id ?? null,
      },
      contextPolicy: { authority: "CONTEXT_OS", expansion: "BOUNDED_PAGE_REQUESTS" },
      sandbox: { present: run.sandboxPath !== undefined },
      providers: this.providers(),
      verificationDetail: {
        attempts: verifications.length,
        latestState: verifications.at(-1)?.state ?? "NOT_EXECUTED",
      },
    };
  }

  private async inspectMission(
    advanced: AdvancedMissionReadModel,
    run: Run,
    task: Task | undefined,
    events: Event<unknown>[],
    verifications: Verification[],
    artifacts: Artifact[],
  ): Promise<InspectMissionReadModel> {
    const candidate = this.candidateFrom(artifacts);
    const obligations = this.obligationsFrom(events);
    const promptEvent = [...events].reverse().find((event) => event.type === "PromptCompiled");
    const promptData = asRecord(promptEvent?.data);
    const compiled = [...events].reverse().find((event) => event.type === "MissionCompiled");
    const compiledData = asRecord(compiled?.data);
    const capsule = await this.dependencies.store.getRecoveryCapsule(run.id);
    const projectId = advanced.projectId;
    const knowledge = projectId
      ? await this.knowledgeSummary(
          projectId,
          this.dependencies.projects.get(projectId)?.revision ?? task?.revision ?? "HEAD",
        )
      : emptyKnowledge();
    const skillVersions = asRecord(promptData.skillVersions);
    return {
      ...advanced,
      depth: "INSPECT",
      missionContract: task?.missionContract
        ? {
            id: task.missionContract.id,
            digest: task.missionContract.digest,
            deniedAuthority: [...task.missionContract.authority.denied],
            grantedAuthority: [...task.missionContract.authority.granted],
            ambiguities: [...task.missionContract.ambiguities],
          }
        : compiled
          ? {
              id: asString(compiledData.missionId) ?? run.id,
              digest: asString(compiledData.missionDigest) ?? "",
              deniedAuthority: Array.isArray(compiledData.deniedAuthority)
                ? (compiledData.deniedAuthority as string[])
                : [],
              grantedAuthority: Array.isArray(compiledData.grantedAuthority)
                ? (compiledData.grantedAuthority as string[])
                : [],
              ambiguities: Array.isArray(compiledData.ambiguities)
                ? (compiledData.ambiguities as string[])
                : [],
            }
          : null,
      candidate,
      trustDerivation: this.trustDerivation(run, candidate, verifications.at(-1), obligations),
      obligations,
      context: this.contextFrom(events),
      why: deriveWhyRecords(events),
      prompt: {
        templateVersion: asString(promptData.templateVersion) ?? null,
        policyVersion: asString(promptData.policyVersion) ?? null,
        skillVersions: Object.keys(skillVersions),
      },
      recovery: {
        present: capsule !== undefined,
        classification: capsule?.recoveryReason ?? null,
      },
      evolution: {
        challengerPresent: false,
        baseline: run.strategyObservationBinding?.id ?? null,
      },
      knowledge,
    };
  }

  private candidateFrom(artifacts: Artifact[]): CandidateInspection | null {
    const candidate = [...artifacts].reverse().find((artifact) => artifact.kind === "DIFF");
    if (!candidate) return null;
    const metadata = asRecord(candidate.metadata);
    const changedFiles = Array.isArray(metadata.changedFiles)
      ? metadata.changedFiles.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      id: asString(metadata.candidateId) ?? candidate.id,
      digest: candidate.digest ?? null,
      attempt: typeof metadata.attempt === "number" ? metadata.attempt : null,
      changedFiles,
      identityAuthority: candidate.digest ? "DETERMINISTIC" : "UNKNOWN",
    };
  }

  private obligationsFrom(events: Event<unknown>[]): ObligationInspection[] {
    const assessed = [...events].reverse().find((event) => event.type === "QualityAssessed");
    const obligations = Array.isArray(asRecord(assessed?.data).obligations)
      ? (asRecord(assessed?.data).obligations as unknown[])
      : [];
    return obligations.map((obligation) => {
      const row = asRecord(obligation);
      const status = (asString(row.status) ?? "UNKNOWN") as CheckOutcomeStatus;
      return {
        id: asString(row.id) ?? "obligation",
        status,
        label: checkOutcomeLabel(status),
        tone: checkOutcomeTone(status),
        capabilityId:
          asString(row.requiredCapability) ??
          asString(row.producedBy) ??
          asString(row.capabilityId) ??
          null,
        justification: asString(row.justification) ?? asString(row.reason) ?? null,
      };
    });
  }

  private trustDerivation(
    run: Run,
    candidate: CandidateInspection | null,
    verification: Verification | undefined,
    obligations: ObligationInspection[],
  ): TrustDerivationStep[] {
    const unresolved = obligations.filter(
      (obligation) => obligation.status !== "PASS" && obligation.status !== "NOT_REQUIRED",
    );
    return [
      {
        stage: "CANDIDATE",
        status: candidate ? "PRESENT" : "ABSENT",
        detail: candidate ? `Candidate ${candidate.id}` : "No candidate captured",
        authority: candidate?.identityAuthority ?? "UNKNOWN",
      },
      {
        stage: "VERIFICATION",
        status: verification?.state ?? "NOT_EXECUTED",
        detail: verification
          ? `Verification ${verification.id} ${verification.state}`
          : "Verification was not executed",
        authority:
          verification?.state === "VERIFIED" &&
          verification.environment &&
          verification.authority?.authorized === true
            ? "VERIFIED"
            : verification?.state === "VERIFIED"
              ? "DETERMINISTIC"
              : "UNKNOWN",
      },
      {
        stage: "EVIDENCE",
        status: obligations.length > 0 ? "RECORDED" : "UNKNOWN",
        detail: `${obligations.length} obligation records`,
        authority: obligations.length > 0 ? "DETERMINISTIC" : "UNKNOWN",
      },
      {
        stage: "OBLIGATIONS",
        status: unresolved.length === 0 && obligations.length > 0 ? "RESOLVED" : "UNRESOLVED",
        detail:
          unresolved.length > 0
            ? unresolved.map((obligation) => `${obligation.id}=${obligation.status}`).join(", ")
            : obligations.length > 0
              ? "No unresolved obligations"
              : "No obligations recorded",
        authority: "DETERMINISTIC",
      },
      {
        stage: "TRUST_STATE",
        status: run.trustState ?? "UNKNOWN",
        detail: trustLabel(run.trustState ?? "UNKNOWN"),
        authority: run.trustState === "MERGE_ELIGIBLE" ? "DETERMINISTIC" : "UNKNOWN",
      },
    ];
  }

  private contextFrom(events: Event<unknown>[]): ContextInspection {
    const built = events.find((event) => event.type === "ContextBuilt");
    const builtData = asRecord(built?.data);
    const ledgers = events.filter((event) => event.type === "ContextLedgerRecorded");
    const latestLedger = asRecord(ledgers.at(-1)?.data);
    const budget = (latestLedger.budget as ContextBudget | undefined) ?? DEFAULT_CONTEXT_BUDGET;
    const expansionEvents = events.filter((event) => event.type === "ContextExpanded").length;
    const reuseEvents = events.filter(
      (event) =>
        event.type === "ContextReused" || asString(asRecord(event.data).reason)?.includes("reuse"),
    ).length;
    const staleRejections = events.filter(
      (event) =>
        event.type === "ContextPageRejected" &&
        asString(asRecord(event.data).reason)?.toLowerCase().includes("stale"),
    ).length;
    const exhaustionEvent = events.find(
      (event) => event.type === "ContextPageRejected" || event.type === "ContextLedgerRecorded",
    );
    const exhaustion =
      asString(asRecord(exhaustionEvent?.data).exhaustion) ??
      (asString(asRecord(exhaustionEvent?.data).reason)?.includes("exhaust")
        ? (asString(asRecord(exhaustionEvent?.data).reason) ?? null)
        : null);
    const initialFiles = Array.isArray(builtData.initialFiles)
      ? builtData.initialFiles.filter((entry): entry is string => typeof entry === "string")
      : [];
    const initialModules = Array.isArray(builtData.initialModules)
      ? builtData.initialModules.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      initialWorkingSet: {
        files: initialFiles.slice(0, CONTROL_CENTER_PAGE.mapFilesPerModule),
        modules: initialModules.slice(0, CONTROL_CENTER_PAGE.mapModules),
        truncated: initialFiles.length > CONTROL_CENTER_PAGE.mapFilesPerModule,
      },
      residentPages: typeof latestLedger.pageCount === "number" ? latestLedger.pageCount : 0,
      handleCount: Array.isArray(latestLedger.entries)
        ? latestLedger.entries.filter((entry) => asRecord(entry).category === "HANDLES").length
        : 0,
      requestCount: events.filter(
        (event) => event.type === "ContextExpanded" || event.type === "ContextPageRejected",
      ).length,
      pageCount: typeof latestLedger.pageCount === "number" ? latestLedger.pageCount : 0,
      budget,
      measuredCharacters:
        typeof latestLedger.measuredCharacters === "number"
          ? latestLedger.measuredCharacters
          : null,
      estimatedTokens:
        typeof latestLedger.estimatedTokens === "number" ? latestLedger.estimatedTokens : null,
      expansionEvents,
      reuseEvents,
      staleRejections,
      exhaustion,
      freshness: ledgers.length > 0 ? "CURRENT" : "UNKNOWN",
      latestLedgerStage: asString(latestLedger.buildStage) ?? null,
    };
  }

  private async runsForRepository(repositoryPath: string): Promise<Run[]> {
    const runs = await this.dependencies.store.listRuns();
    const tasks = await Promise.all(runs.map((run) => this.dependencies.store.getTask(run.taskId)));
    return runs.filter((_, index) => tasks[index]?.repositoryPath === repositoryPath);
  }

  private async knowledgeSummary(projectId: string, revision: string): Promise<KnowledgeSummary> {
    const basis = await this.liveKnowledgeBasis(projectId, revision);
    const resolved = await this.dependencies.projectBrain.resolveCurrent({
      projectId,
      revision,
      ...basis,
      limit: CONTROL_CENTER_PAGE.knowledgePage,
    });
    return {
      examined: resolved.examined,
      current: resolved.current.length,
      stale: resolved.staleIds.length,
      unknown: resolved.unknownIds.length,
      conflicted: resolved.conflictedIds.length,
      truncated: resolved.truncated,
    };
  }

  private async liveKnowledgeBasis(
    projectId: string,
    revision: string,
  ): Promise<
    Pick<Parameters<ProjectBrain["resolveCurrent"]>[0], "sourceDigests" | "moduleMembershipDigests">
  > {
    const project = this.dependencies.projects.get(projectId);
    if (!project || !existsSync(project.repositoryPath)) {
      return { sourceDigests: {}, moduleMembershipDigests: {} };
    }
    try {
      const records = await this.dependencies.projectBrain.list(
        projectId,
        revision,
        undefined,
        CONTROL_CENTER_PAGE.knowledgePage,
      );
      const sourceUris = [
        ...new Set(
          records.flatMap((record) =>
            (record.stalenessInputs ?? [])
              .filter((binding) => binding.type === "SOURCE_DIGEST")
              .map((binding) => binding.uri),
          ),
        ),
      ];
      const modules = [
        ...new Set(
          records.flatMap((record) =>
            (record.stalenessInputs ?? [])
              .filter((binding) => binding.type === "MODULE_MEMBERSHIP")
              .map((binding) => binding.module),
          ),
        ),
      ];
      const initial = await this.dependencies.repositoryIndex.index(
        project.repositoryPath,
        revision,
      );
      const snapshot =
        sourceUris.length > 0
          ? await this.dependencies.repositoryIndex.indexScope(
              project.repositoryPath,
              revision,
              initial,
              sourceUris,
            )
          : initial;
      const basis = knowledgeResolutionBasis(snapshot, modules);
      const observed = new Map(snapshot.evidence.map((entry) => [entry.uri, entry.digest]));
      return {
        sourceDigests: Object.fromEntries(
          sourceUris.map((uri) => [uri, observed.get(uri) ?? "MISSING_FROM_CURRENT_SNAPSHOT"]),
        ),
        moduleMembershipDigests: basis.moduleMembershipDigests,
      };
    } catch {
      return { sourceDigests: {}, moduleMembershipDigests: {} };
    }
  }
}
