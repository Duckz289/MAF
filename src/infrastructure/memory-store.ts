import { isDeepStrictEqual } from "node:util";
import { assertHealthSample, type HealthSample } from "../domain/health";
import type { RunStore } from "../domain/ports";
import { projectIdentity } from "../domain/project-identity";
import { redactSensitiveData } from "../domain/security";
import {
  assertStrategyObservation,
  strategyObservationBinding,
  type StrategyObservation,
} from "../domain/strategy";
import type {
  Artifact,
  Event,
  RecoveryCapsule,
  Run,
  RuntimeSignalSnapshot,
  Task,
  Verification,
} from "../domain/types";

export class InMemoryRunStore implements RunStore {
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, Run>();
  private readonly eventsByRun = new Map<string, Event<unknown>[]>();
  private readonly artifactsByRun = new Map<string, Artifact[]>();
  private readonly verificationsByRun = new Map<string, Verification[]>();
  private readonly signalSnapshotsByRun = new Map<string, RuntimeSignalSnapshot[]>();
  private readonly recoveryCapsulesByRun = new Map<string, RecoveryCapsule>();
  private readonly healthSamples: HealthSample[] = [];
  private readonly strategyObservations: StrategyObservation[] = [];
  private readonly strategyCanaryOrdinals = new Map<string, number>();

  async createTask(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  async createRun(run: Run): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async updateRun(run: Run): Promise<void> {
    if (!this.runs.has(run.id)) throw new Error(`Unknown run: ${run.id}`);
    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(id: string): Promise<Run | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()]
      .map((run) => structuredClone(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendEvent(event: Event<unknown>): Promise<void> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    events.push(structuredClone(event));
    this.eventsByRun.set(event.runId, events);
  }

  async listEvents(runId: string, after?: string): Promise<Event<unknown>[]> {
    const events = this.eventsByRun.get(runId) ?? [];
    const index = after ? events.findIndex((event) => event.id === after) + 1 : 0;
    return events.slice(Math.max(0, index)).map((event) => structuredClone(event));
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    const artifacts = this.artifactsByRun.get(artifact.runId) ?? [];
    artifacts.push(structuredClone(artifact));
    this.artifactsByRun.set(artifact.runId, artifacts);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return (this.artifactsByRun.get(runId) ?? []).map((artifact) => structuredClone(artifact));
  }

  async addVerification(verification: Verification): Promise<void> {
    const verifications = this.verificationsByRun.get(verification.runId) ?? [];
    verifications.push(structuredClone(verification));
    this.verificationsByRun.set(verification.runId, verifications);
  }

  async listVerifications(runId: string): Promise<Verification[]> {
    return (this.verificationsByRun.get(runId) ?? []).map((verification) =>
      structuredClone(verification),
    );
  }

  async addSignalSnapshot(snapshot: RuntimeSignalSnapshot): Promise<void> {
    const snapshots = this.signalSnapshotsByRun.get(snapshot.runId) ?? [];
    snapshots.push(structuredClone(snapshot));
    this.signalSnapshotsByRun.set(snapshot.runId, snapshots);
  }

  async listSignalSnapshots(runId: string): Promise<RuntimeSignalSnapshot[]> {
    return (this.signalSnapshotsByRun.get(runId) ?? []).map((snapshot) =>
      structuredClone(snapshot),
    );
  }

  async saveRecoveryCapsule(capsule: RecoveryCapsule): Promise<void> {
    this.recoveryCapsulesByRun.set(capsule.runId, structuredClone(capsule));
  }

  async getRecoveryCapsule(runId: string): Promise<RecoveryCapsule | undefined> {
    const capsule = this.recoveryCapsulesByRun.get(runId);
    return capsule ? structuredClone(capsule) : undefined;
  }

  async saveHealthSample(sample: HealthSample): Promise<void> {
    const sanitizedSample: unknown = redactSensitiveData(sample);
    assertHealthSample(sanitizedSample);
    sample = sanitizedSample;
    const run = this.runs.get(sample.runId);
    const task = run ? this.tasks.get(run.taskId) : undefined;
    const artifact = (this.artifactsByRun.get(sample.runId) ?? []).find(
      (entry) => entry.id === sample.candidateId,
    );
    const verifiedCandidate = (this.verificationsByRun.get(sample.runId) ?? []).some(
      (entry) => entry.state === "VERIFIED" && entry.candidateId === sample.candidateId,
    );
    if (
      !run ||
      !task ||
      run.state !== "COMPLETED" ||
      run.verificationState !== "VERIFIED" ||
      projectIdentity(task.repositoryPath) !== sample.projectId ||
      artifact?.kind !== "DIFF" ||
      artifact.runId !== sample.runId ||
      artifact.digest !== sample.candidateDigest ||
      artifact.metadata.baseRevision !== sample.revision ||
      !verifiedCandidate
    ) {
      throw new Error(
        "Health sample is not bound to a verified run and matching candidate artifact",
      );
    }
    if (this.healthSamples.some((existing) => existing.runId === sample.runId)) {
      throw new Error(`Health sample already exists for run: ${sample.runId}`);
    }
    this.healthSamples.push(structuredClone(sample));
  }

  async listHealthSamples(projectId?: string, limit?: number): Promise<HealthSample[]> {
    const ordered = this.healthSamples
      .filter((sample) => projectId === undefined || sample.projectId === projectId)
      .toSorted(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) || left.runId.localeCompare(right.runId),
      );
    const boundedLimit = Math.min(500, limit === undefined ? ordered.length : Math.max(0, limit));
    const window = boundedLimit === 0 ? [] : ordered.slice(-boundedLimit);
    return structuredClone(window);
  }

  async saveStrategyObservation(observation: StrategyObservation): Promise<void> {
    const sanitized: unknown = redactSensitiveData(observation);
    assertStrategyObservation(sanitized);
    observation = sanitized;
    const run = observation.runId ? this.runs.get(observation.runId) : undefined;
    const task = run ? this.tasks.get(run.taskId) : undefined;
    const artifact = run
      ? (this.artifactsByRun.get(run.id) ?? []).find(
          (entry) => entry.id === observation.candidateId,
        )
      : undefined;
    const matchingCandidateOutcome = run
      ? (this.verificationsByRun.get(run.id) ?? []).some(
          (entry) =>
            entry.state === run.verificationState && entry.candidateId === observation.candidateId,
        )
      : false;
    const expectedProfile = task?.verification.command
      ? "COMMAND"
      : task?.verification.expectedFile
        ? "EXPECTED_FILE"
        : "DEFAULT";
    if (
      !run ||
      !task ||
      (run.state !== "COMPLETED" && run.state !== "FAILED") ||
      observation.verifiedSuccess !== (run.verificationState === "VERIFIED") ||
      (observation.evidenceBasis === "RUN_STORE_VERIFIED") !== observation.verifiedSuccess ||
      (observation.evidenceBasis === "RUN_STORE_TERMINAL") !== !observation.verifiedSuccess ||
      run.trustState !== observation.trustState ||
      run.completedAt !== observation.timestamp ||
      run.retryCount !== observation.retries ||
      (observation.costUsd !== null && run.cost.total !== observation.costUsd) ||
      projectIdentity(task.repositoryPath) !== observation.scope.projectId ||
      artifact?.kind !== "DIFF" ||
      artifact.runId !== run.id ||
      artifact.digest !== observation.candidateDigest ||
      !matchingCandidateOutcome ||
      observation.strategy.adapter !== run.agent ||
      observation.strategy.model !== run.model ||
      observation.strategy.provider !== run.provider ||
      observation.strategy.executionMode !== run.effectiveMode ||
      observation.strategy.qualityPreference !== (task.qualityPreference ?? "BALANCED") ||
      observation.strategy.verificationProfile !== expectedProfile ||
      observation.strategy.baseline !== "CHALLENGER" ||
      !run.strategyEvidenceBinding ||
      run.strategyEvidenceBinding.projectId !== observation.scope.projectId ||
      run.strategyEvidenceBinding.taskClass !== observation.scope.taskClass ||
      run.strategyEvidenceBinding.riskProfile !== observation.scope.riskProfile ||
      run.strategyEvidenceBinding.qualityRequirement !== observation.scope.qualityRequirement ||
      run.strategyEvidenceBinding.reviewPolicy !== observation.strategy.reviewPolicy ||
      !run.strategyObservationBinding ||
      !isDeepStrictEqual(run.strategyObservationBinding, strategyObservationBinding(observation))
    ) {
      throw new Error("Strategy observation is not bound to its verified run and candidate");
    }
    if (this.strategyObservations.some((entry) => entry.runId === run.id))
      throw new Error(`Strategy observation already exists for run: ${run.id}`);
    this.strategyObservations.push(structuredClone(observation));
  }

  async listStrategyObservations(
    projectId?: string,
    limit?: number,
  ): Promise<StrategyObservation[]> {
    const ordered = this.strategyObservations
      .filter((entry) => projectId === undefined || entry.scope.projectId === projectId)
      .toSorted(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) ||
          (left.runId ?? "").localeCompare(right.runId ?? ""),
      );
    const bounded = Math.min(500, Math.max(0, limit ?? 500));
    return structuredClone(bounded === 0 ? [] : ordered.slice(-bounded));
  }

  async allocateStrategyCanaryOrdinal(allocationKey: string): Promise<number> {
    if (!/^strategy-[a-f0-9]{64}$/u.test(allocationKey))
      throw new Error("Malformed strategy allocation key");
    const ordinal = this.strategyCanaryOrdinals.get(allocationKey) ?? 0;
    this.strategyCanaryOrdinals.set(allocationKey, ordinal + 1);
    return ordinal;
  }
}
