import type { RunStore } from "../domain/ports";
import type {
  Artifact,
  Event,
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
}
