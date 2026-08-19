import path from "node:path";
import type {
  RepositorySnapshot,
  RuntimeObservation,
  RuntimeSignalCollector,
} from "../domain/ports";
import type {
  RuntimeSignalEvidence,
  RuntimeSignalName,
  RuntimeSignalProvenance,
  RuntimeSignalReliability,
  RuntimeSignals,
  RuntimeSignalSnapshot,
  RuntimeSignalValue,
  RuntimeSignalValues,
} from "../domain/types";

export interface RuntimeSignalPolicy {
  stabilizationWindow: number;
  minimumMechanicalEdits: number;
}

export const defaultRuntimeSignalPolicy: RuntimeSignalPolicy = {
  stabilizationWindow: 5,
  minimumMechanicalEdits: 2,
};

interface MeaningfulActivity {
  expanded: boolean;
  editPattern?: string;
}

interface CollectorState {
  repository: RepositorySnapshot;
  initialFiles: Set<string>;
  initialModules: Set<string>;
  observedFiles: Set<string>;
  observedModules: Set<string>;
  changedFiles: Set<string>;
  expandedFiles: Set<string>;
  verificationFailures: number;
  externalHints: RuntimeSignals;
  agentInferences: Partial<RuntimeSignals>;
  evidence: RuntimeSignalEvidence[];
  meaningful: MeaningfulActivity[];
  snapshots: RuntimeSignalSnapshot[];
}

const normalizeFile = (value: string): string =>
  value
    .replace(/^file:\/\//u, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");

const moduleLookup = (snapshot: RepositorySnapshot): Map<string, string> => {
  const lookup = new Map<string, string>();
  for (const [module, files] of Object.entries(snapshot.moduleMap)) {
    for (const file of files) lookup.set(normalizeFile(file), module);
  }
  return lookup;
};

const findRepositoryFile = (candidate: string, files: Set<string>): string | undefined => {
  const normalized = normalizeFile(candidate);
  if (files.has(normalized)) return normalized;
  return [...files].find((file) => normalized.endsWith(`/${file}`));
};

const extractFileCandidates = (value: unknown, key = "", output = new Set<string>()): string[] => {
  if (typeof value === "string" && /(file|path|target|uri)/iu.test(key)) output.add(value);
  if (Array.isArray(value) && /(file|path|target|uri)/iu.test(key)) {
    for (const child of value) if (typeof child === "string") output.add(child);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value))
      extractFileCandidates(child, childKey, output);
  }
  return [...output];
};

const editPattern = (data: Record<string, unknown>, files: string[]): string | undefined => {
  const operation = String(data.action ?? data.operation ?? data.tool ?? data.updateType ?? "");
  if (!/(write|edit|create|patch|replace)/iu.test(operation)) return undefined;
  const extensions = [...new Set(files.map((file) => path.posix.extname(file) || "none"))].sort();
  return `${operation.toLowerCase()}:${extensions.join(",")}`;
};

const reliabilityFor = (provenance: RuntimeSignalProvenance): RuntimeSignalReliability =>
  provenance === "DETERMINISTIC" ? "HIGH" : provenance === "HEURISTIC" ? "MEDIUM" : "LOW";

export class EvidenceRuntimeSignalCollector implements RuntimeSignalCollector {
  private readonly states = new Map<string, CollectorState>();

  constructor(private readonly policy: RuntimeSignalPolicy = defaultRuntimeSignalPolicy) {
    if (policy.stabilizationWindow < 2) throw new Error("Stabilization window must be at least 2");
    if (policy.minimumMechanicalEdits < 1)
      throw new Error("Mechanical edit threshold must be positive");
  }

  async observe(observation: RuntimeObservation): Promise<RuntimeSignalSnapshot> {
    if (observation.type === "INITIAL_CONTEXT") {
      if (this.states.has(observation.runId))
        throw new Error(`Runtime signal collector already initialized for ${observation.runId}`);
      const files = new Set(observation.repository.files.map(normalizeFile));
      const initialFiles = new Set(
        observation.initialFiles
          .map((candidate) => findRepositoryFile(candidate, files))
          .filter((candidate): candidate is string => Boolean(candidate)),
      );
      const state: CollectorState = {
        repository: structuredClone(observation.repository),
        initialFiles,
        initialModules: new Set(observation.initialModules),
        observedFiles: new Set(initialFiles),
        observedModules: new Set(observation.initialModules),
        changedFiles: new Set(),
        expandedFiles: new Set(),
        verificationFailures: 0,
        externalHints: structuredClone(observation.externalHints ?? {}),
        agentInferences: {},
        evidence: [],
        meaningful: [],
        snapshots: [],
      };
      this.states.set(observation.runId, state);
      this.addEvidence(state, {
        source: "context-builder",
        provenance: "DETERMINISTIC",
        summary: "Initial repository scope selected for the native agent",
        data: {
          files: [...initialFiles].sort(),
          modules: [...state.initialModules].sort(),
        },
        timestamp: observation.timestamp,
      });
      for (const [name, value] of Object.entries(state.externalHints)) {
        if (value === undefined) continue;
        this.addEvidence(state, {
          source: "run-request",
          provenance: "EXTERNAL_HINT",
          summary: `External compatibility hint supplied for ${name}`,
          data: { signal: name, value },
          timestamp: observation.timestamp,
        });
      }
      return this.snapshot(observation.runId, state, observation.checkpoint, observation.timestamp);
    }

    const state = this.requireState(observation.runId);
    if (observation.type === "AGENT_EVENT") this.observeAgentEvent(state, observation);
    if (observation.type === "DIFF_CAPTURED") this.observeDiff(state, observation);
    if (observation.type === "VERIFICATION") this.observeVerification(state, observation);
    return this.snapshot(observation.runId, state, observation.checkpoint, observation.timestamp);
  }

  async latest(runId: string): Promise<RuntimeSignalSnapshot | undefined> {
    const latest = this.states.get(runId)?.snapshots.at(-1);
    return latest ? structuredClone(latest) : undefined;
  }

  async history(runId: string): Promise<RuntimeSignalSnapshot[]> {
    return (this.states.get(runId)?.snapshots ?? []).map((snapshot) => structuredClone(snapshot));
  }

  private observeAgentEvent(
    state: CollectorState,
    observation: Extract<RuntimeObservation, { type: "AGENT_EVENT" }>,
  ): void {
    const repositoryFiles = new Set(state.repository.files.map(normalizeFile));
    const files = extractFileCandidates(observation.event.data)
      .map((candidate) => findRepositoryFile(candidate, repositoryFiles))
      .filter((candidate): candidate is string => Boolean(candidate));
    const lookup = moduleLookup(state.repository);
    const newFiles: string[] = [];
    const newModules: string[] = [];
    for (const file of files) {
      if (!state.observedFiles.has(file)) {
        state.observedFiles.add(file);
        newFiles.push(file);
        if (!state.initialFiles.has(file)) state.expandedFiles.add(file);
      }
      const module = lookup.get(file);
      if (module && !state.observedModules.has(module)) {
        state.observedModules.add(module);
        newModules.push(module);
      }
    }
    const expanded = newFiles.length > 0 || newModules.length > 0;
    const meaningful =
      observation.event.type === "tool" || observation.event.type === "context_expansion";
    if (meaningful) {
      const pattern = editPattern(observation.event.data, files);
      state.meaningful.push({
        expanded,
        ...(pattern ? { editPattern: pattern } : {}),
      });
    }
    if (expanded) {
      this.addEvidence(state, {
        source: `agent-event:${observation.event.type}`,
        provenance: "DETERMINISTIC",
        summary: "Agent activity reached repository scope outside the previously observed set",
        data: { files: newFiles.sort(), modules: newModules.sort() },
        timestamp: observation.timestamp,
      });
    } else if (meaningful && files.length > 0) {
      this.addEvidence(state, {
        source: `agent-event:${observation.event.type}`,
        provenance: "DETERMINISTIC",
        summary: "Agent activity remained inside the known repository scope",
        data: { files: [...new Set(files)].sort() },
        timestamp: observation.timestamp,
      });
    }
    const uncertainty = observation.event.data.rootCauseUncertainty;
    if (typeof uncertainty === "number" && uncertainty >= 0 && uncertainty <= 1) {
      state.agentInferences.rootCauseUncertainty = uncertainty;
      this.addEvidence(state, {
        source: "agent-report",
        provenance: "AGENT_INFERENCE",
        summary: "Agent reported root-cause uncertainty",
        data: { value: uncertainty },
        timestamp: observation.timestamp,
      });
    }
    const mechanical = observation.event.data.mechanicalRemainingWork;
    if (typeof mechanical === "boolean") {
      state.agentInferences.mechanicalRemainingWork = mechanical;
      this.addEvidence(state, {
        source: "agent-report",
        provenance: "AGENT_INFERENCE",
        summary: "Agent classified the remaining work",
        data: { mechanicalRemainingWork: mechanical },
        timestamp: observation.timestamp,
      });
    }
    if (observation.event.type === "context_expansion" && files.length === 0) {
      this.addEvidence(state, {
        source: "agent-report",
        provenance: "AGENT_INFERENCE",
        summary: "Agent declared context expansion without repository-file evidence",
        data: { declaredCount: observation.event.data.count ?? null },
        timestamp: observation.timestamp,
      });
    }
  }

  private observeDiff(
    state: CollectorState,
    observation: Extract<RuntimeObservation, { type: "DIFF_CAPTURED" }>,
  ): void {
    const lookup = moduleLookup(state.repository);
    const repositoryFiles = new Set(state.repository.files.map(normalizeFile));
    const newModules: string[] = [];
    for (const candidate of observation.diff.changedFiles) {
      const normalized = normalizeFile(candidate);
      state.changedFiles.add(normalized);
      const file = findRepositoryFile(normalized, repositoryFiles) ?? normalized;
      state.observedFiles.add(file);
      const module =
        lookup.get(file) ?? (file.includes("/") ? file.split("/")[0] : "root") ?? "root";
      if (!state.observedModules.has(module)) newModules.push(module);
      state.observedModules.add(module);
      if (!state.initialFiles.has(file)) state.expandedFiles.add(file);
    }
    state.meaningful.push({ expanded: newModules.length > 0 });
    this.addEvidence(state, {
      source: "git-diff",
      provenance: "DETERMINISTIC",
      summary: "Git recorded the final changed-file set",
      data: { files: [...state.changedFiles].sort(), newModules: newModules.sort() },
      timestamp: observation.timestamp,
    });
  }

  private observeVerification(
    state: CollectorState,
    observation: Extract<RuntimeObservation, { type: "VERIFICATION" }>,
  ): void {
    if (observation.verification.state !== "VERIFIED") state.verificationFailures += 1;
    this.addEvidence(state, {
      source: "verifier-history",
      provenance: "DETERMINISTIC",
      summary: "Verification attempt recorded by the trusted verifier",
      data: {
        attempt:
          state.verificationFailures + (observation.verification.state === "VERIFIED" ? 1 : 0),
        state: observation.verification.state,
        exitCode: observation.verification.exitCode ?? null,
      },
      timestamp: observation.timestamp,
    });
  }

  private snapshot(
    runId: string,
    state: CollectorState,
    checkpoint: string,
    timestamp: string,
  ): RuntimeSignalSnapshot {
    const signals: RuntimeSignalValues = {};
    const deterministicEvidenceIds = state.evidence
      .filter((evidence) => evidence.provenance === "DETERMINISTIC")
      .map((evidence) => evidence.id);
    const externalEvidenceIds = state.evidence
      .filter((evidence) => evidence.provenance === "EXTERNAL_HINT")
      .map((evidence) => evidence.id);
    const agentEvidenceIds = state.evidence
      .filter((evidence) => evidence.provenance === "AGENT_INFERENCE")
      .map((evidence) => evidence.id);
    const deterministic = <Name extends RuntimeSignalName>(
      name: Name,
      value: NonNullable<RuntimeSignals[Name]>,
      source: string,
    ): void => {
      signals[name] = this.value(
        value,
        source,
        "DETERMINISTIC",
        deterministicEvidenceIds,
        timestamp,
      ) as never;
    };
    const lookup = moduleLookup(state.repository);
    const involved = state.observedModules;
    const meaningfulEdges = new Set<string>();
    for (const relation of state.repository.relations) {
      if (relation.kind !== "IMPORTS") continue;
      const fromModule = lookup.get(normalizeFile(relation.from));
      const toModule = lookup.get(normalizeFile(relation.to));
      if (!fromModule || !toModule || fromModule === toModule) continue;
      if (involved.has(fromModule) && involved.has(toModule))
        meaningfulEdges.add(`${fromModule}->${toModule}`);
    }
    const expandedModules = [...involved].filter((module) => !state.initialModules.has(module));
    deterministic("touchedModules", involved.size, "repository-observation");
    deterministic("dependencyExpansion", expandedModules.length, "initial-scope-comparison");
    deterministic("contextExpansion", state.expandedFiles.size, "observed-repository-files");
    deterministic("crossModuleEdges", meaningfulEdges.size, "resolved-local-import-graph");
    deterministic("filesChanged", state.changedFiles.size, "git-diff");
    deterministic("newDependenciesDiscovered", meaningfulEdges.size, "resolved-local-import-graph");
    deterministic("repeatedVerifierFailures", state.verificationFailures, "verifier-history");
    deterministic("verificationFailureCount", state.verificationFailures, "verifier-history");

    const recent = state.meaningful.slice(-this.policy.stabilizationWindow);
    const scopeStabilized =
      recent.length === this.policy.stabilizationWindow &&
      state.observedModules.size > 0 &&
      recent.every((activity) => !activity.expanded);
    const stabilizationEvidence = this.addEvidence(state, {
      source: "scope-stability-policy",
      provenance: "HEURISTIC",
      summary: scopeStabilized
        ? "Recent meaningful activity introduced no new repository scope"
        : "Repository scope has not met the stabilization window",
      data: {
        window: this.policy.stabilizationWindow,
        observed: recent.length,
        expansions: recent.filter((activity) => activity.expanded).length,
      },
      timestamp,
    });
    const externalScope = state.externalHints.scopeStabilized;
    signals.scopeStabilized =
      recent.length < this.policy.stabilizationWindow && externalScope !== undefined
        ? this.value(externalScope, "run-request", "EXTERNAL_HINT", externalEvidenceIds, timestamp)
        : this.value(
            scopeStabilized,
            "scope-stability-policy",
            "HEURISTIC",
            [stabilizationEvidence.id],
            timestamp,
          );

    const stableEdits = recent
      .map((activity) => activity.editPattern)
      .filter((pattern): pattern is string => Boolean(pattern));
    const mechanicalHeuristic =
      scopeStabilized &&
      stableEdits.length >= this.policy.minimumMechanicalEdits &&
      new Set(stableEdits).size === 1;
    const mechanicalEvidence = this.addEvidence(state, {
      source: "mechanical-work-policy",
      provenance: "HEURISTIC",
      summary: mechanicalHeuristic
        ? "Stable edits share one structural operation pattern"
        : "Remaining work is not yet evidenced as mechanical",
      data: {
        stableEdits: stableEdits.length,
        patterns: [...new Set(stableEdits)].sort(),
        required: this.policy.minimumMechanicalEdits,
      },
      timestamp,
    });
    if (mechanicalHeuristic) {
      signals.mechanicalRemainingWork = this.value(
        true,
        "mechanical-work-policy",
        "HEURISTIC",
        [mechanicalEvidence.id],
        timestamp,
      );
    } else if (state.agentInferences.mechanicalRemainingWork !== undefined) {
      signals.mechanicalRemainingWork = this.value(
        state.agentInferences.mechanicalRemainingWork,
        "agent-report",
        "AGENT_INFERENCE",
        agentEvidenceIds,
        timestamp,
      );
    } else if (state.externalHints.mechanicalRemainingWork !== undefined) {
      signals.mechanicalRemainingWork = this.value(
        state.externalHints.mechanicalRemainingWork,
        "run-request",
        "EXTERNAL_HINT",
        externalEvidenceIds,
        timestamp,
      );
    } else {
      signals.mechanicalRemainingWork = this.value(
        false,
        "mechanical-work-policy",
        "HEURISTIC",
        [mechanicalEvidence.id],
        timestamp,
      );
    }

    this.copyInferenceOrHint(state, signals, "rootCauseUncertainty", timestamp);
    this.copyInferenceOrHint(state, signals, "independentWorkstreams", timestamp);

    const snapshot: RuntimeSignalSnapshot = {
      id: crypto.randomUUID(),
      runId,
      sequence: state.snapshots.length + 1,
      checkpoint,
      timestamp,
      signals,
      evidence: state.evidence.slice(-50).map((evidence) => structuredClone(evidence)),
    };
    state.snapshots.push(snapshot);
    return structuredClone(snapshot);
  }

  private copyInferenceOrHint(
    state: CollectorState,
    signals: RuntimeSignalValues,
    name: "rootCauseUncertainty" | "independentWorkstreams",
    timestamp: string,
  ): void {
    const agentValue = state.agentInferences[name];
    const hintValue = state.externalHints[name];
    if (agentValue !== undefined) {
      signals[name] = this.value(
        agentValue,
        "agent-report",
        "AGENT_INFERENCE",
        state.evidence
          .filter((item) => item.provenance === "AGENT_INFERENCE")
          .map((item) => item.id),
        timestamp,
      ) as never;
    } else if (hintValue !== undefined) {
      signals[name] = this.value(
        hintValue,
        "run-request",
        "EXTERNAL_HINT",
        state.evidence.filter((item) => item.provenance === "EXTERNAL_HINT").map((item) => item.id),
        timestamp,
      ) as never;
    }
  }

  private value<T extends number | boolean>(
    value: T,
    source: string,
    provenance: RuntimeSignalProvenance,
    evidenceIds: string[],
    timestamp: string,
  ): RuntimeSignalValue<T> {
    return {
      value,
      source,
      provenance,
      reliability: reliabilityFor(provenance),
      evidenceIds: [...new Set(evidenceIds)].slice(-20),
      timestamp,
    };
  }

  private addEvidence(
    state: CollectorState,
    evidence: Omit<RuntimeSignalEvidence, "id">,
  ): RuntimeSignalEvidence {
    const complete = { id: crypto.randomUUID(), ...evidence };
    state.evidence.push(complete);
    return complete;
  }

  private requireState(runId: string): CollectorState {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Runtime signal collector is not initialized for ${runId}`);
    return state;
  }
}
