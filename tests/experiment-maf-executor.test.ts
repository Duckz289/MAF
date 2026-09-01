import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../src/benchmark/runner";
import { MafExperimentExecutor } from "../evaluation/experiments/real/lib/maf-executor";
import {
  FakeAgentAdapter,
  authFailureScript,
  bareNonzeroExitScript,
  costedProviderFailureScript,
  providerFailureScript,
  signalTerminationScript,
  successScript,
  successThenNonzeroExitScript,
  uncostedProviderFailureScript,
} from "./fixtures/fake-agent-adapter";
import { FakeRepositoryIndex, FakeRuntimeSignalCollector } from "./fixtures/fake-signal-collector";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "maf-maf-executor-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const baseTask = (): BenchmarkTask => ({
  id: "maf-executor-test-task",
  prompt: "do the thing",
  expectedVerification: "n/a",
  candidateWorkspaces: { MAF_ADAPTIVE: workspace },
});

const buildExecutor = (
  adapter: FakeAgentAdapter,
  options: {
    signalsQueue?: Array<Record<string, number | boolean>>;
    timeoutMs?: number;
    budgetUsd?: number;
    maxRecoveryAttempts?: number;
    maxProviderInvocations?: number;
  } = {},
) =>
  new MafExperimentExecutor({
    requestedModel: "claude-sonnet-5",
    effort: "high",
    provider: "anthropic",
    timeoutMs: options.timeoutMs ?? 30_000,
    budgetUsd: options.budgetUsd ?? 8,
    minimumAttemptTimeMs: 10,
    minimumAttemptBudgetUsd: 0.001,
    ...(options.maxRecoveryAttempts !== undefined
      ? { maxRecoveryAttempts: options.maxRecoveryAttempts }
      : {}),
    ...(options.maxProviderInvocations !== undefined
      ? { maxProviderInvocations: options.maxProviderInvocations }
      : {}),
    adapter,
    repositoryIndex: new FakeRepositoryIndex(),
    signalCollector: new FakeRuntimeSignalCollector(options.signalsQueue ?? []),
  });

describe("MafExperimentExecutor", () => {
  it("reports a completed, self-reported-success run with no interventions", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.verificationResult).toBe("VERIFIED");
    expect(execution.initialMode).toBe("GUIDED");
    expect(execution.retryCount).toBe(0);

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.maf?.interventions).toBe(0);
    // MAF keeps its real prompt preamble (no empty-preamble override, unlike NATIVE).
    expect(adapter.startedInputs[0]?.initialContext).not.toBe("");
  });

  it("escalates to SOLO_NATIVE and records evidence-bound mode transitions", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter, {
      signalsQueue: [{}, { dependencyExpansion: 5 }],
    });
    const execution = await executor.execute(baseTask());

    expect(execution.finalMode).toBe("SOLO_NATIVE");
    expect(execution.modeTransitions).toHaveLength(1);
    expect(execution.modeTransitions[0]?.signalSnapshotId).toBe(execution.signalSnapshots[0]?.id);

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.maf?.escalations).toBe(1);
    expect(side?.maf?.transitions[0]?.enforcementMethod).toBe("DEFERRED_BOUNDARY");
  });
});

describe("retry amplification repair (proven Finding 1)", () => {
  it("does NOT retry a bare nonzero exit, the exact shape that caused the overrun", async () => {
    // Only one script is queued: a second spawn would throw, so this asserts the absence of a retry.
    const adapter = new FakeAgentAdapter([bareNonzeroExitScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("INFRA_FAILURE");
    expect(execution.retryCount).toBe(0);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.failureClassification).toBe("CLI_PROCESS_FAILURE");
    expect(side?.ceilings.providerInvocationsStarted).toBe(1);
  });

  it("does NOT retry an auth failure, which a retry could never fix", async () => {
    const adapter = new FakeAgentAdapter([authFailureScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    expect(executor.sideChannel.get(execution.runId as string)?.failureClassification).toBe(
      "AUTH_CONFIGURATION_FAILURE",
    );
  });

  it("does NOT retry a signal termination, and keeps it distinct from exit(1)", async () => {
    const adapter = new FakeAgentAdapter([signalTerminationScript("SIGKILL")]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    const attempt = executor.sideChannel.get(execution.runId as string)?.attempts[0];
    expect(attempt?.exitCode).toBeNull();
    expect(attempt?.terminationSignal).toBe("SIGKILL");
  });

  it("STILL retries a genuine provider failure, so the frozen treatment is not disabled", async () => {
    // The failed attempt must report a cost: an unmeasured attempt legitimately blocks any further
    // billed retry (see the fail-closed test below), so a costless script would test the wrong rule.
    const adapter = new FakeAgentAdapter([costedProviderFailureScript(0.5), successScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.retryCount).toBe(1);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.ceilings.providerInvocationsStarted).toBe(2);
    expect(side?.attempts.filter((attempt) => attempt.started)).toHaveLength(2);
  });
});

describe("preflight invocation ceiling (one authorization = one invocation)", () => {
  it("BLOCKS a second provider invocation before spawn when only one is allowed", async () => {
    // A retryable provider failure would normally justify a retry; the ceiling must stop it anyway.
    const adapter = new FakeAgentAdapter([providerFailureScript()]);
    const executor = buildExecutor(adapter, {
      maxRecoveryAttempts: 1,
      maxProviderInvocations: 1,
    });
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.ceilings.providerInvocationsStarted).toBe(1);
    expect(side?.ceilings.providerInvocationsRefused).toBe(1);
    // The refusal is recorded as evidence rather than silently omitted.
    const refused = side?.attempts.find((attempt) => !attempt.started);
    expect(refused?.refusalReason).toBe("INVOCATION_CEILING_REACHED");
  });

  it("with maxRecoveryAttempts=0 (billed preflight rule) never makes a second invocation", async () => {
    const adapter = new FakeAgentAdapter([providerFailureScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 0 });
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    expect(
      executor.sideChannel.get(execution.runId as string)?.ceilings.providerInvocationsStarted,
    ).toBe(1);
  });
});

describe("run-level ceilings across retries", () => {
  it("caps a retry at the REMAINING run budget, not a fresh full per-run ceiling", async () => {
    const adapter = new FakeAgentAdapter([costedProviderFailureScript(3), successScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1, budgetUsd: 8 });
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    const started = side?.attempts.filter((attempt) => attempt.started) ?? [];
    expect(started[0]?.attemptBudgetUsd).toBe(8);
    // $3 already spent -> the retry may use at most $5.
    expect(started[1]?.attemptBudgetUsd).toBe(5);
    expect(execution.executionStatus).toBe("COMPLETED");
  });

  it("caps a retry at the REMAINING run deadline rather than restarting the timer", async () => {
    const adapter = new FakeAgentAdapter([costedProviderFailureScript(1), successScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1, timeoutMs: 30_000 });
    const execution = await executor.execute(baseTask());

    const started =
      executor.sideChannel.get(execution.runId as string)?.attempts.filter((a) => a.started) ?? [];
    expect(started).toHaveLength(2);
    // The retry is bounded by what REMAINS of the run deadline, never granted a fresh full timer.
    // (The fake adapter completes in well under a millisecond, so the observable decrement here is
    // ~0; the strict decrementing behavior is proven against an injected clock in
    // tests/experiment-run-ledger.test.ts.)
    expect(started[1]?.attemptTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(started[1]?.attemptTimeoutMs).toBeLessThanOrEqual(started[0]?.attemptTimeoutMs ?? 0);
  });

  it("fails closed: an UNKNOWN-cost first attempt blocks any further billed retry", async () => {
    const adapter = new FakeAgentAdapter([uncostedProviderFailureScript()]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    const side = executor.sideChannel.get(execution.runId as string);
    const refused = side?.attempts.find((attempt) => !attempt.started);
    expect(refused?.refusalReason).toBe("REMAINING_BUDGET_UNKNOWN");
    expect(side?.ceilings.remainingRunBudgetUsdAtEnd).toBeNull();
  });
});

describe("multi-attempt cost accounting", () => {
  it("sums a failed attempt and a successful retry ($2 + $1 = $3)", async () => {
    const adapter = new FakeAgentAdapter([
      costedProviderFailureScript(2),
      successScript({ costUsd: 1 }),
    ]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    // A failed attempt's spend is real money and is never dropped because a retry succeeded.
    expect(side?.cost.participantCostUsd).toBe(3);
    expect(side?.cost.totalCostUsd).toBe(3);
    expect(side?.cost.costStatus).toBe("KNOWN");
    expect(execution.reportedCost).toBe(3);
  });

  it("keeps orchestration cost at a proven zero: every invocation is a PARTICIPANT call", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.cost.orchestrationCostUsd).toBe(0);
    // The claim is provable, not assumed: no attempt was an orchestration model call.
    expect(side?.attempts.every((attempt) => attempt.purpose === "PARTICIPANT")).toBe(true);
  });

  it("reports PARTIAL cost when one attempt reported and another did not", async () => {
    // First attempt reports $2 and is retryable; the retry reports no cost at all.
    const adapter = new FakeAgentAdapter([
      costedProviderFailureScript(2),
      [
        {
          type: "usage",
          data: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: null },
          timestamp: new Date().toISOString(),
        },
        {
          type: "complete",
          data: { result: "done", subtype: "success", isError: false },
          timestamp: new Date().toISOString(),
        },
      ],
    ]);
    const executor = buildExecutor(adapter, { maxRecoveryAttempts: 1 });
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.cost.costStatus).toBe("PARTIAL");
    expect(side?.cost.participantCostUsd).toBe(2);
    expect(side?.cost.note).toMatch(/lower bound/i);
  });
});

describe("terminal-state repair (proven Finding 2)", () => {
  it("keeps a structured success COMPLETED despite a later nonzero exit", async () => {
    const adapter = new FakeAgentAdapter([successThenNonzeroExitScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    const attempt = executor.sideChannel.get(execution.runId as string)?.attempts[0];
    expect(attempt?.exitCodeDiscrepancy).toBe(true);
    expect(attempt?.exitCode).toBe(1);
  });
});

describe("workspace ownership", () => {
  it("throws when no controller-owned MAF_ADAPTIVE workspace was allocated", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter);
    const task: BenchmarkTask = { id: "no-workspace", prompt: "x", expectedVerification: "n/a" };
    await expect(executor.execute(task)).rejects.toThrow(/controller-owned MAF_ADAPTIVE workspace/);
  });
});
