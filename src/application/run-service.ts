import path from "node:path";
import type {
  AgentAdapter,
  ContextBuilderPort,
  ProjectBrain,
  RepositoryIndex,
  RunStore,
  Sandbox,
  SandboxProvider,
  TelemetrySink,
  VerifierPort,
} from "../domain/ports";
import { AdaptiveModeController } from "../domain/mode-controller";
import {
  emptyCost,
  emptyUsage,
  type Artifact,
  type Event,
  type ExecutionMode,
  type Run,
  type RuntimeSignals,
  type Task,
  type VerificationSpec,
} from "../domain/types";
import { LocalWorktreeSandbox } from "../infrastructure/local-worktree";

export interface CreateRunRequest {
  prompt: string;
  repositoryPath: string;
  revision?: string | undefined;
  mode?: ExecutionMode | undefined;
  verification?: VerificationSpec | undefined;
  signals?: RuntimeSignals | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  credentialReferences?: string[] | undefined;
}

export interface RunSummary extends Run {
  task: string;
  currentPhase: string;
  lastMeaningfulEvent?: { type: string; timestamp: string };
  modeTransitions: number;
  operationalStatus: "QUEUED" | "RUNNING" | "STUCK" | "VERIFIED" | "FAILED" | "CANCELLED";
}

interface RunServiceDependencies {
  store: RunStore;
  agent: AgentAdapter;
  sandbox: SandboxProvider;
  verifier: VerifierPort;
  repositoryIndex: RepositoryIndex;
  projectBrain: ProjectBrain;
  contextBuilder: ContextBuilderPort;
  telemetry: TelemetrySink;
  modeController?: AdaptiveModeController;
}

export class RunService {
  private readonly active = new Map<string, { cancelled: boolean; sandbox?: Sandbox }>();
  private readonly modeController: AdaptiveModeController;

  constructor(private readonly dependencies: RunServiceDependencies) {
    this.modeController = dependencies.modeController ?? new AdaptiveModeController();
  }

  async create(request: CreateRunRequest): Promise<Run> {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: request.prompt,
      repositoryPath: path.resolve(request.repositoryPath),
      revision: request.revision ?? "HEAD",
      createdAt: now,
      verification: request.verification ?? {},
      ...(request.signals ? { signals: request.signals } : {}),
    };
    const run: Run = {
      id: crypto.randomUUID(),
      taskId: task.id,
      state: "QUEUED",
      executionMode: this.modeController.initial(request.mode),
      verificationState: "PROPOSED",
      agent: request.agent ?? this.dependencies.agent.name,
      model: request.model ?? "native",
      provider: request.provider ?? "native",
      createdAt: now,
      updatedAt: now,
      changedFiles: [],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
    };
    await this.dependencies.store.createTask(task);
    await this.dependencies.store.createRun(run);
    await this.event(run.id, "RunCreated", {
      taskId: task.id,
      executionMode: run.executionMode,
      agent: run.agent,
      model: run.model,
    });
    this.active.set(run.id, { cancelled: false });
    void this.execute(run, task, request.credentialReferences ?? []);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.dependencies.store.getRun(id);
  }

  async list(): Promise<Run[]> {
    return this.dependencies.store.listRuns();
  }

  async listSummaries(): Promise<RunSummary[]> {
    const runs = await this.dependencies.store.listRuns();
    return Promise.all(
      runs.map(async (run) => {
        const [task, events] = await Promise.all([
          this.dependencies.store.getTask(run.taskId),
          this.dependencies.store.listEvents(run.id),
        ]);
        const elapsed = Date.now() - Date.parse(run.startedAt ?? run.createdAt);
        const operationalStatus: RunSummary["operationalStatus"] =
          run.verificationState === "VERIFIED"
            ? "VERIFIED"
            : run.state === "FAILED"
              ? "FAILED"
              : run.state === "CANCELLED"
                ? "CANCELLED"
                : run.state === "COMPLETED"
                  ? "VERIFIED"
                  : run.state === "RUNNING" && elapsed > 5 * 60_000
                    ? "STUCK"
                    : run.state;
        const last = events.at(-1);
        return {
          ...run,
          task: task?.prompt ?? "Unknown task",
          currentPhase: this.currentPhase(run, last?.type),
          ...(last ? { lastMeaningfulEvent: { type: last.type, timestamp: last.timestamp } } : {}),
          modeTransitions: events.filter((event) => event.type === "ModeChanged").length,
          operationalStatus,
        };
      }),
    );
  }

  async events(id: string, after?: string): Promise<Event<unknown>[]> {
    return this.dependencies.store.listEvents(id, after);
  }

  async artifacts(id: string): Promise<Artifact[]> {
    return this.dependencies.store.listArtifacts(id);
  }

  async waitForIdle(id: string, timeoutMs = 15_000): Promise<void> {
    const started = performance.now();
    while (this.active.has(id)) {
      if (performance.now() - started > timeoutMs) throw new Error(`Run ${id} did not become idle`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async cancel(id: string): Promise<Run> {
    const run = await this.requireRun(id);
    const active = this.active.get(id);
    if (!active || run.state === "COMPLETED" || run.state === "FAILED") return run;
    active.cancelled = true;
    await this.dependencies.verifier.cancel(id);
    run.state = "CANCELLED";
    run.verificationState = "CANCELLED";
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    await this.dependencies.store.updateRun(run);
    await this.event(id, "RunCancelled", {});
    return run;
  }

  async transition(
    id: string,
    to: ExecutionMode,
    reason: string,
    evidence: Record<string, string | number | boolean>,
  ): Promise<Run> {
    const run = await this.requireRun(id);
    if (run.executionMode === to) return run;
    const event = this.modeController.apply(run, { to, reason, evidence });
    await this.dependencies.store.updateRun(run);
    await this.dependencies.store.appendEvent(event);
    return run;
  }

  private async execute(run: Run, task: Task, credentialReferences: string[]): Promise<void> {
    const started = performance.now();
    let modeTransitions = 0;
    let sandbox: Sandbox | undefined;
    try {
      run.state = "RUNNING";
      run.startedAt = new Date().toISOString();
      run.updatedAt = run.startedAt;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "RunStarted", {});

      const initialDecision = this.modeController.decide(run.executionMode, task.signals ?? {});
      if (initialDecision) {
        await this.dependencies.store.appendEvent(this.modeController.apply(run, initialDecision));
        modeTransitions += 1;
      }

      sandbox = await this.dependencies.sandbox.create(run.id, task.repositoryPath, task.revision);
      const active = this.active.get(run.id);
      if (active) active.sandbox = sandbox;
      run.sandboxPath = sandbox.path;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "SandboxStarted", {
        provider: "LocalWorktree",
        path: sandbox.path,
        revision: sandbox.revision,
      });

      await this.dependencies.projectBrain.markStale(task.repositoryPath, task.revision);
      const snapshot = await this.dependencies.repositoryIndex.index(sandbox.path, task.revision);
      const context = await this.dependencies.contextBuilder.build({
        task,
        mode: run.executionMode,
        snapshot,
        projectId: task.repositoryPath,
      });
      await this.event(run.id, "ContextBuilt", {
        tokenEstimate: context.tokenEstimate,
        evidenceIds: context.evidenceIds,
        modules: Object.keys(snapshot.moduleMap).length,
        symbols: snapshot.symbols.length,
      });

      const session = await this.dependencies.agent.start({
        run,
        task,
        workspacePath: sandbox.path,
        initialContext: context.text,
        credentialReferences,
      });
      await this.dependencies.agent.send(session, task.prompt);
      for await (const agentEvent of this.dependencies.agent.events(session)) {
        if (this.active.get(run.id)?.cancelled) {
          await this.dependencies.agent.cancel(session);
          throw new Error("Run cancelled");
        }
        await this.event(run.id, "AgentEvent", agentEvent);
        if (agentEvent.type === "usage") {
          run.usage.input += Number(agentEvent.data.inputTokens ?? 0);
          run.usage.output += Number(agentEvent.data.outputTokens ?? 0);
          run.usage.cached += Number(agentEvent.data.cachedTokens ?? 0);
        }
        if (agentEvent.type === "context_expansion") {
          await this.event(run.id, "ContextExpanded", agentEvent.data);
          const decision = this.modeController.decide(run.executionMode, {
            ...(task.signals ?? {}),
            dependencyExpansion: Number(agentEvent.data.count ?? 1),
            contextExpansion: Number(agentEvent.data.count ?? 1),
          });
          if (decision) {
            await this.dependencies.store.appendEvent(this.modeController.apply(run, decision));
            modeTransitions += 1;
          }
        }
        if (agentEvent.type === "error")
          throw new Error(String(agentEvent.data.message ?? "Agent failed"));
      }

      const diff = await this.dependencies.sandbox.collectDiff(sandbox);
      run.changedFiles = diff.changedFiles;
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        runId: run.id,
        kind: "DIFF",
        uri: `sandbox://${run.id}/changes.patch`,
        digest: LocalWorktreeSandbox.digest(diff),
        metadata: {
          changedFiles: diff.changedFiles,
          bytes: Buffer.byteLength(diff.patch),
          preview: diff.patch.slice(0, 20_000),
        },
        createdAt: new Date().toISOString(),
      };
      await this.dependencies.store.addArtifact(artifact);
      await this.event(run.id, "DiffCaptured", {
        artifactId: artifact.id,
        changedFiles: diff.changedFiles,
        digest: artifact.digest,
      });

      run.verificationState = "VERIFYING";
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "VerificationChanged", { state: "VERIFYING" });
      const verification = await this.dependencies.verifier.verify(run, task, sandbox, diff);
      await this.dependencies.store.addVerification(verification);
      run.verificationState = verification.state;
      run.state = verification.state === "VERIFIED" ? "COMPLETED" : "FAILED";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "VerificationChanged", {
        state: verification.state,
        exitCode: verification.exitCode,
        output: verification.output,
      });
      await this.event(run.id, "RunCompleted", {
        state: run.state,
        verificationState: run.verificationState,
      });
      try {
        await this.dependencies.telemetry.record({
          taskId: task.id,
          runId: run.id,
          agent: run.agent,
          model: run.model,
          provider: run.provider,
          executionMode: run.executionMode,
          inputTokens: run.usage.input,
          outputTokens: run.usage.output,
          cachedTokens: run.usage.cached,
          modelCost: run.cost.model,
          sandboxCost: run.cost.sandbox,
          verificationCost: run.cost.verification,
          retryCost: run.cost.retry,
          recoveryCost: run.cost.recovery,
          latencyMs: performance.now() - started,
          retryCount: run.retryCount,
          filesChanged: run.changedFiles.length,
          verificationType: "command",
          verificationState: run.verificationState,
          modeTransitions,
          verifiedSuccess: run.verificationState === "VERIFIED",
          timestamp: run.completedAt,
        });
      } catch (telemetryError) {
        await this.event(run.id, "TelemetryFailed", {
          error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
        });
      }
    } catch (error) {
      const latest = await this.dependencies.store.getRun(run.id);
      if (latest?.state !== "CANCELLED") {
        run.state = "FAILED";
        run.verificationState = run.verificationState === "VERIFYING" ? "QUARANTINED" : "FAILED";
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.dependencies.store.updateRun(run);
        await this.event(run.id, "RunFailed", { error: run.error });
      }
    } finally {
      if (sandbox) {
        try {
          await this.dependencies.sandbox.cleanup(sandbox, run.verificationState);
          await this.event(run.id, "SandboxFinalized", {
            verificationState: run.verificationState,
          });
        } catch (cleanupError) {
          await this.event(run.id, "SandboxCleanupFailed", {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      this.active.delete(run.id);
    }
  }

  private async event(runId: string, type: string, data: unknown): Promise<void> {
    await this.dependencies.store.appendEvent({
      id: crypto.randomUUID(),
      runId,
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async requireRun(id: string): Promise<Run> {
    const run = await this.dependencies.store.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }

  private currentPhase(run: Run, lastEvent?: string): string {
    if (run.verificationState === "VERIFYING") return "Verification";
    if (run.verificationState === "VERIFIED") return "Verified handoff";
    if (run.verificationState === "QUARANTINED") return "Quarantine review";
    if (run.state === "QUEUED") return "Queued";
    if (lastEvent === "ContextBuilt") return "Agent execution";
    if (lastEvent === "DiffCaptured") return "Verification";
    return run.state === "RUNNING" ? "Repository and context" : run.state;
  }
}
