import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../src/benchmark/runner";
import { NativeExperimentExecutor } from "../evaluation/experiments/real/lib/native-executor";
import {
  FakeAgentAdapter,
  authFailureScript,
  bareNonzeroExitScript,
  participantLimitScript,
  providerFailureScript,
  successScript,
  successUnknownCostScript,
} from "./fixtures/fake-agent-adapter";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "maf-native-executor-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const baseTask = (): BenchmarkTask => ({
  id: "native-executor-test-task",
  prompt: "do the thing",
  expectedVerification: "n/a",
  candidateWorkspaces: { NATIVE: workspace },
});

const executorConfig = (adapter: FakeAgentAdapter, timeoutMs = 30_000) => ({
  requestedModel: "claude-sonnet-5",
  effort: "high",
  provider: "anthropic",
  timeoutMs,
  budgetUsd: 8,
  // Thresholds lowered so short deterministic test timeouts are still above the ledger's
  // "not enough left to be worth an attempt" floor.
  minimumAttemptTimeMs: 10,
  minimumAttemptBudgetUsd: 0.001,
  adapter,
});

describe("NativeExperimentExecutor", () => {
  it("reports a completed, self-reported-success run", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.verificationResult).toBe("VERIFIED");
    expect(execution.initialMode).toBe("NATIVE");
    expect(execution.finalMode).toBe("NATIVE");
    expect(execution.modeTransitions).toEqual([]);
    expect(execution.inputTokens).toBe(100);
    expect(execution.reportedCost).toBe(0.05);

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.resolvedModel).toBe("claude-sonnet-5-20250929");
    expect(side?.resolvedModelStatus).toBe("RESOLVED");
    expect(side?.cost.costStatus).toBe("KNOWN");
    expect(side?.failureClassification).toBe("COMPLETED");
    expect(side?.firstFailure).toBeNull();
    // Native must never receive MAF framing text.
    expect(adapter.startedInputs[0]?.initialContext).toBe("");
  });

  it("never spawns more than one provider invocation for a Native run", async () => {
    const adapter = new FakeAgentAdapter([bareNonzeroExitScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.ceilings.providerInvocationsStarted).toBe(1);
    expect(side?.ceilings.providerInvocationsAllowed).toBe(1);
    expect(side?.attempts.filter((attempt) => attempt.started)).toHaveLength(1);
  });

  it("does NOT auto-retry a bare nonzero exit (the authorization-overrun shape)", async () => {
    // Only one script is queued: a retry would throw "no script queued", so this asserts absence.
    const adapter = new FakeAgentAdapter([bareNonzeroExitScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("INFRA_FAILURE");
    expect(execution.retryCount).toBe(0);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.failureClassification).toBe("CLI_PROCESS_FAILURE");
    // The failure must explain itself, not just restate an exit code.
    expect(side?.firstFailure).toMatch(/no terminal result/i);
  });

  it("classifies a participant's own limit as a valid, non-DVS run rather than infra failure", async () => {
    const adapter = new FakeAgentAdapter([participantLimitScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.verificationResult).toBe("FAILED");
    expect(execution.providerError).toBeUndefined();
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.failureClassification).toBe("PARTICIPANT_TASK_FAILURE");
  });

  it("persists stderr, exit code and result subtype for a failed attempt", async () => {
    const adapter = new FakeAgentAdapter([authFailureScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    const attempt = executor.sideChannel.get(execution.runId as string)?.attempts[0];
    expect(attempt?.stderr.observed).toBe(true);
    expect(attempt?.stderr.summary).toMatch(/authentication failed/i);
    expect(attempt?.exitCode).toBe(1);
    expect(attempt?.terminationSignal).toBeNull();
    expect(attempt?.classification).toBe("AUTH_CONFIGURATION_FAILURE");
  });

  it("keeps cost UNKNOWN when no cost was reported, never coercing it to 0", async () => {
    const adapter = new FakeAgentAdapter([successUnknownCostScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.reportedCost).toBeNull();
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.cost.costStatus).toBe("UNKNOWN");
    expect(side?.cost.participantCostUsd).toBeNull();
    expect(side?.cost.totalCostUsd).toBeNull();
    expect(side?.cost.note).toMatch(/not because zero usage was confirmed/i);
  });

  it("records a placeholder model identity without ever calling it RESOLVED", async () => {
    const adapter = new FakeAgentAdapter([successScript({ resolvedModel: "<synthetic>" })]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.resolvedModelStatus).toBe("PLACEHOLDER_OR_SYNTHETIC");
    expect(side?.resolvedModel).toBeNull();
    expect(side?.rawReportedModel).toBe("<synthetic>");
  });

  it("classifies a runaway participant as TIMEOUT and cancels the session", async () => {
    const adapter = new FakeAgentAdapter(["HANG"]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter, 200));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("TIMEOUT");
    expect(adapter.cancelledSessionIds.length).toBe(1);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.timeout.timedOut).toBe(true);
  });

  it("does not auto-retry even a provider failure, because Native runs exactly once", async () => {
    const adapter = new FakeAgentAdapter([providerFailureScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.retryCount).toBe(0);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.failureClassification).toBe("PROVIDER_FAILURE");
    expect(side?.ceilings.providerInvocationsStarted).toBe(1);
  });

  it("throws when no controller-owned NATIVE workspace was allocated", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const task: BenchmarkTask = { id: "no-workspace", prompt: "x", expectedVerification: "n/a" };
    await expect(executor.execute(task)).rejects.toThrow(/controller-owned NATIVE workspace/);
  });
});
