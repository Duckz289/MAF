import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService, type RecoveryPolicy } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { BudgetReservationPolicy } from "../src/domain/budget";
import { ProviderCircuitBreaker } from "../src/domain/circuit-breaker";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../src/domain/ports";
import type { AgentCapabilities, AgentEvent } from "../src/domain/types";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (
  sandboxRoot: string,
  overrides?: {
    recoveryPolicy?: Partial<RecoveryPolicy>;
    budgetReservationPolicy?: Partial<BudgetReservationPolicy>;
  },
) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const telemetry = new DomainTelemetryRecorder();
  const service = new RunService({
    store,
    agent: new NativeCliAdapter({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        path.resolve("src/fixtures/native-agent.ts"),
      ],
    }),
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
    verifier: new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
    ...(overrides?.recoveryPolicy ? { recoveryPolicy: overrides.recoveryPolicy } : {}),
    ...(overrides?.budgetReservationPolicy
      ? { budgetReservationPolicy: overrides.budgetReservationPolicy }
      : {}),
  });
  return { service, telemetry, store };
};

describe("budget authority", () => {
  it("refuses to start any agent session when even the execution reserve is exhausted", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      budget: { mode: "HARD", limitUsd: 0 },
    });
    const paused = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(paused?.state, paused?.error).toBe("PAUSED");
    const capsule = await service.recoveryCapsule(created.id);
    expect(capsule?.recoveryReason).toBe("BUDGET_EXHAUSTED");
    // No agent session should ever have started — the run never had a chance to spend anything.
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "AgentEvent")).toBe(false);
    const allocated = events.find((event) => event.type === "BudgetAllocated");
    expect(allocated?.data).toMatchObject({ mode: "HARD", configured: true });
  });

  it("stops repairing once the execution budget is exhausted, without upgrading the verification result", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Attempt a bounded repair that remains unverifiable and report execution cost:5",
      repositoryPath: fixture.path,
      verification: { expectedFile: "missing-proof.txt" },
      // Execution reserve is 60% of 5 = 3; the first session reports cost 5, exhausting it before
      // the repair loop's next authorization check — even though the repair-attempt count budget
      // (default 1) has not yet been reached.
      budget: { mode: "HARD", limitUsd: 5 },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    // The run still completes (reaches a safe boundary) rather than pausing outright — budget
    // reduced scope (no repair attempt) without silently reducing trust (still QUARANTINED, never
    // upgraded to VERIFIED).
    expect(completed?.verificationState, completed?.error).toBe("QUARANTINED");
    const events = await service.events(created.id);
    const stopped = events.find((event) => event.type === "VerificationRepairStopped");
    expect(stopped?.data).toMatchObject({ reason: "budget-exhausted", repairAttempts: 0 });
    expect(events.some((event) => event.type === "VerificationRepairStarted")).toBe(false);
  });

  it("never blocks ADVISORY-budget spend even past the configured limit", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact and report execution cost:100",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      budget: { mode: "ADVISORY", limitUsd: 1 },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
  });

  it("leaves the run fully permissive when no budget is configured", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    const allocated = events.find((event) => event.type === "BudgetAllocated");
    expect(allocated?.data).toMatchObject({
      mode: "ADVISORY",
      configured: false,
      allocation: null,
    });
  });

  it("rejects an implausible self-reported cost instead of applying it", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      // 5000 exceeds maxPlausibleSingleEventCostUsd (1000).
      prompt: "Write the fixture artifact and report execution cost:5000",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
    expect(completed?.cost.model).toBe(0);
    const events = await service.events(created.id);
    const ignored = events.find((event) => event.type === "ImplausibleCostIgnored");
    expect(ignored?.data).toMatchObject({ reported: 5000 });
  });

  it(
    "attributes a recovery retry's reported cost to the recovery reserve, not execution",
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixtureRepository();
      fixtures.push(fixture);
      const { service } = harness(fixture.sandboxRoot, {
        recoveryPolicy: { maxRecoveryAttempts: 1 },
      });
      const created = await service.create({
        // The first attempt fails before reporting any cost (see native-agent.ts); the recovery
        // retry succeeds and reports cost 5 on that SECOND attempt specifically.
        prompt: "simulate transient failure once and report execution cost:5",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
      );
      await service.waitForIdle(created.id);
      expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
      expect(completed?.cost.recovery).toBe(5);
      expect(completed?.cost.model).toBe(0);
    },
  );

  it(
    "denies a recovery retry on an exhausted recovery reserve and labels the capsule BUDGET_EXHAUSTED",
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixtureRepository();
      fixtures.push(fixture);
      // All budget goes to "execution" (so the first session can start) and none to "recovery" —
      // any recovery retry is denied immediately regardless of how little it would have cost.
      const { service } = harness(fixture.sandboxRoot, {
        recoveryPolicy: { maxRecoveryAttempts: 5 },
        budgetReservationPolicy: { executionShare: 1, verificationShare: 0, recoveryShare: 0 },
      });
      const created = await service.create({
        prompt: "simulate transient failure once",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
        budget: { mode: "HARD", limitUsd: 10 },
      });
      const paused = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
      );
      await service.waitForIdle(created.id);
      expect(paused?.state, paused?.error).toBe("PAUSED");
      const capsule = await service.recoveryCapsule(created.id);
      // The ORIGINAL failure (agent-reported, so AGENT_FAILURE, auto-retryable) is not why the
      // run stopped — budget is. The capsule must say so, not misattribute the stop to the
      // original transient-looking failure that budget merely prevented a retry of.
      expect(capsule?.recoveryReason).toBe("BUDGET_EXHAUSTED");
      expect(capsule?.recoveryDetail).toContain("AGENT_FAILURE");
      // A budget WAS configured, so remainingBudget must be a real number, not the always-null
      // placeholder.
      expect(capsule?.remainingBudget).not.toBeNull();
      expect(typeof capsule?.remainingBudget).toBe("number");
      const events = await service.events(created.id);
      // Exactly one recovery attempt was DECIDED AGAINST (never started) due to budget.
      expect(events.filter((event) => event.type === "RecoveryAttempted")).toHaveLength(0);
    },
  );
});

/** A minimal AgentAdapter double whose start() always fails with a provider-shaped error. */
class BrokenProviderAgent implements AgentAdapter {
  readonly name = "broken-provider";
  startCallCount = 0;

  async capabilities(): Promise<AgentCapabilities> {
    return {
      repoSearch: true,
      fileRead: true,
      fileWrite: true,
      shell: true,
      browser: false,
      mcp: false,
      nativePlanning: true,
      nativeSubagents: false,
      contextManagement: true,
      streaming: true,
      resumeSession: false,
      livePolicyUpdate: false,
      safeSessionRestart: false,
      oauthAuth: false,
      apiKeyAuth: true,
      extensions: {},
    };
  }

  async start(_input: AgentStartInput): Promise<AgentSession> {
    this.startCallCount += 1;
    throw new Error("ECONNRESET calling provider");
  }

  async send(): Promise<void> {}
  async *events(): AsyncIterable<AgentEvent> {
    // Never reached: start() always throws before any session exists to stream events for. The
    // unreachable yield only exists to satisfy the AgentAdapter interface's generator return type.
    if (this.startCallCount < 0) yield { type: "message", data: {}, timestamp: "" };
  }
  async cancel(): Promise<void> {}
  async resume(): Promise<AgentSession> {
    throw new Error("resume is not supported");
  }
}

describe("provider circuit breaker", () => {
  it("opens after repeated provider failures and refuses the next run without attempting it", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const brokenAgent = new BrokenProviderAgent();
    const circuitBreaker = new ProviderCircuitBreaker({
      failureThreshold: 2,
      degradedThreshold: 1,
      cooldownMs: 60_000,
    });
    const store = new InMemoryRunStore();
    const brain = new InMemoryProjectBrain();
    const service = new RunService({
      store,
      agent: brokenAgent,
      sandbox: new LocalWorktreeSandbox(fixture.sandboxRoot, "none"),
      verifier: new CommandVerifier(),
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
      recoveryPolicy: { maxRecoveryAttempts: 1 },
      circuitBreaker,
    });

    const first = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await waitFor(
      () => service.get(first.id),
      (run) => run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(first.id);
    // Two attempts (initial + one bounded recovery retry) against the same always-failing
    // provider is enough to reach the failureThreshold of 2 and open the circuit.
    expect(brokenAgent.startCallCount).toBe(2);
    expect(circuitBreaker.state("native")).toBe("OPEN_CIRCUIT");

    const second = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const secondPaused = await waitFor(
      () => service.get(second.id),
      (run) => run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(second.id);
    // The circuit refuses the attempt before the agent is ever called again.
    expect(brokenAgent.startCallCount).toBe(2);
    expect(secondPaused?.state).toBe("PAUSED");
    const capsule = await service.recoveryCapsule(second.id);
    expect(capsule?.recoveryReason).toBe("PROVIDER_DEGRADED");
    expect(capsule?.recoveryDetail).toContain("circuit is open");
  });
});
