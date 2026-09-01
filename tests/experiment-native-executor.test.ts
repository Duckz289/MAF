import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../src/benchmark/runner";
import { NativeExperimentExecutor } from "../evaluation/experiments/real/lib/native-executor";
import {
  FakeAgentAdapter,
  arrivedFailureScript,
  providerErrorScript,
  successScript,
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

const executorConfig = (adapter: FakeAgentAdapter) => ({
  requestedModel: "claude-sonnet-5",
  effort: "high",
  provider: "anthropic",
  timeoutMs: 200,
  budgetUsd: 8,
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
    expect(execution.outputTokens).toBe(50);
    expect(execution.reportedCost).toBe(0.05);
    expect(execution.runId).toBeDefined();

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.resolvedModel).toBe("claude-sonnet-5-20250929");
    expect(side?.resolvedModelStatus).toBe("RESOLVED");
    expect(side?.cost.costStatus).toBe("KNOWN");
    expect(side?.candidateWorkspace).toBe(workspace);

    // Native must never receive MAF framing text.
    expect(adapter.startedInputs[0]?.initialContext).toBe("");
  });

  it("reports a completed run the participant itself did not solve as a valid non-DVS outcome", async () => {
    const adapter = new FakeAgentAdapter([arrivedFailureScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.verificationResult).toBe("FAILED");
  });

  it("classifies a runaway participant as TIMEOUT and cancels the session", async () => {
    const adapter = new FakeAgentAdapter(["HANG"]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("TIMEOUT");
    expect(adapter.cancelledSessionIds.length).toBe(1);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.timeout.timedOut).toBe(true);
    expect(side?.cost.costStatus).toBe("UNKNOWN");
  });

  it("classifies an adapter-reported error with no completion as INFRA_FAILURE", async () => {
    const adapter = new FakeAgentAdapter([providerErrorScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("INFRA_FAILURE");
    expect(execution.providerError).toContain("ECONNRESET");
  });

  it("throws when no controller-owned NATIVE workspace was allocated", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = new NativeExperimentExecutor(executorConfig(adapter));
    const task: BenchmarkTask = {
      id: "no-workspace",
      prompt: "x",
      expectedVerification: "n/a",
    };
    await expect(executor.execute(task)).rejects.toThrow(/controller-owned NATIVE workspace/);
  });
});
