import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../src/benchmark/runner";
import { MafExperimentExecutor } from "../evaluation/experiments/real/lib/maf-executor";
import {
  FakeAgentAdapter,
  nonRetryableErrorScript,
  providerErrorScript,
  successScript,
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
  signalsQueue: Array<Record<string, number | boolean>> = [],
  timeoutMs = 200,
) =>
  new MafExperimentExecutor({
    requestedModel: "claude-sonnet-5",
    effort: "high",
    provider: "anthropic",
    timeoutMs,
    budgetUsd: 8,
    adapter,
    repositoryIndex: new FakeRepositoryIndex(),
    signalCollector: new FakeRuntimeSignalCollector(signalsQueue),
  });

describe("MafExperimentExecutor", () => {
  it("reports a completed, self-reported-success run with no interventions", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.verificationResult).toBe("VERIFIED");
    expect(execution.initialMode).toBe("GUIDED");
    expect(execution.finalMode).toBe("GUIDED");
    expect(execution.modeTransitions).toEqual([]);
    expect(execution.retryCount).toBe(0);

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.maf?.interventions).toBe(0);
    expect(side?.maf?.escalations).toBe(0);
    // MAF keeps its real prompt preamble (no empty-preamble override, unlike NATIVE).
    expect(adapter.startedInputs[0]?.initialContext).not.toBe("");
  });

  it("escalates to SOLO_NATIVE and records evidence-bound mode transitions", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    // Queue: [0] initial-context observation (unused by decide), [1] first AGENT_EVENT observation
    // (the "usage" event) crosses the GUIDED->SOLO_NATIVE dependencyExpansion threshold (>=3).
    const executor = buildExecutor(adapter, [{}, { dependencyExpansion: 5 }]);
    const execution = await executor.execute(baseTask());

    expect(execution.finalMode).toBe("SOLO_NATIVE");
    expect(execution.modeTransitions).toHaveLength(1);
    expect(execution.modeTransitions[0]?.from).toBe("GUIDED");
    expect(execution.modeTransitions[0]?.to).toBe("SOLO_NATIVE");
    expect(execution.signalSnapshots).toHaveLength(1);
    expect(execution.modeTransitions[0]?.signalSnapshotId).toBe(execution.signalSnapshots[0]?.id);

    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.maf?.interventions).toBe(1);
    expect(side?.maf?.escalations).toBe(1);
    expect(side?.maf?.transitions[0]?.enforcementMethod).toBe("DEFERRED_BOUNDARY");
  });

  it("retries exactly once on an auto-retryable provider failure, then succeeds", async () => {
    const adapter = new FakeAgentAdapter([providerErrorScript(), successScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("COMPLETED");
    expect(execution.retryCount).toBe(1);
    const side = executor.sideChannel.get(execution.runId as string);
    expect(side?.maf?.retries).toBe(1);
  });

  it("does not retry a non-retryable provider failure", async () => {
    const adapter = new FakeAgentAdapter([nonRetryableErrorScript()]);
    const executor = buildExecutor(adapter);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("INFRA_FAILURE");
    expect(execution.retryCount).toBe(0);
  });

  it("classifies a runaway participant as TIMEOUT without retrying", async () => {
    const adapter = new FakeAgentAdapter(["HANG"]);
    const executor = buildExecutor(adapter, [], 50);
    const execution = await executor.execute(baseTask());

    expect(execution.executionStatus).toBe("TIMEOUT");
    expect(execution.retryCount).toBe(0);
    expect(adapter.cancelledSessionIds.length).toBe(1);
  });

  it("throws when no controller-owned MAF_ADAPTIVE workspace was allocated", async () => {
    const adapter = new FakeAgentAdapter([successScript()]);
    const executor = buildExecutor(adapter);
    const task: BenchmarkTask = { id: "no-workspace", prompt: "x", expectedVerification: "n/a" };
    await expect(executor.execute(task)).rejects.toThrow(/controller-owned MAF_ADAPTIVE workspace/);
  });
});
