import type {
  RepositoryIndex,
  RepositorySnapshot,
  RuntimeObservation,
  RuntimeSignalCollector,
} from "../../src/domain/ports";
import type {
  RuntimeSignalReliability,
  RuntimeSignals,
  RuntimeSignalSnapshot,
  RuntimeSignalValue,
  RuntimeSignalValues,
} from "../../src/domain/types";

/** Deterministic RepositoryIndex double: no git repository or filesystem walk required. */
export class FakeRepositoryIndex implements RepositoryIndex {
  readonly name = "fake-repository-index";

  async index(_repositoryPath: string, revision: string): Promise<RepositorySnapshot> {
    return {
      revision,
      files: ["src/example.ts"],
      filesTruncated: false,
      symbols: [],
      relations: [],
      moduleMap: {},
      moduleOwnership: {},
      packageOwnership: {},
      moduleRoots: [],
      parsedFiles: [],
      scopeTruncated: false,
      evidence: [],
    };
  }

  async indexScope(
    _repositoryPath: string,
    _revision: string,
    snapshot: RepositorySnapshot,
  ): Promise<RepositorySnapshot> {
    return snapshot;
  }

  async structuralSearch(): Promise<string[]> {
    return [];
  }
}

const asSignalValue = (value: number | boolean): RuntimeSignalValue => {
  const reliability: RuntimeSignalReliability = "HIGH";
  return {
    value,
    source: "test-fixture",
    provenance: "DETERMINISTIC",
    reliability,
    evidenceIds: [],
    timestamp: new Date().toISOString(),
  };
};

/**
 * Deterministic RuntimeSignalCollector double. Each `observe()` call (one INITIAL_CONTEXT, then one
 * per AGENT_EVENT) pops the next queued partial `RuntimeSignals` and wraps it into a real, correctly
 * shaped `RuntimeSignalSnapshot` -- so the REAL AdaptiveModeController can be driven deterministically
 * without depending on the heuristic engine's exact tool-call/file-path thresholds.
 */
export class FakeRuntimeSignalCollector implements RuntimeSignalCollector {
  private sequence = 0;
  private readonly snapshots: RuntimeSignalSnapshot[] = [];

  constructor(private readonly queue: Array<Partial<RuntimeSignals>> = []) {}

  async observe(observation: RuntimeObservation): Promise<RuntimeSignalSnapshot> {
    this.sequence += 1;
    const partial = this.queue.shift() ?? {};
    const signals: RuntimeSignalValues = {};
    for (const [name, value] of Object.entries(partial)) {
      if (value === undefined) continue;
      (signals as Record<string, RuntimeSignalValue>)[name] = asSignalValue(value);
    }
    const snapshot: RuntimeSignalSnapshot = {
      id: crypto.randomUUID(),
      runId: observation.runId,
      sequence: this.sequence,
      checkpoint: observation.checkpoint,
      timestamp: observation.timestamp,
      signals,
      evidence: [],
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  async latest(_runId: string): Promise<RuntimeSignalSnapshot | undefined> {
    return this.snapshots.at(-1);
  }

  async history(_runId: string): Promise<RuntimeSignalSnapshot[]> {
    return [...this.snapshots];
  }
}
