import { describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
} from "../src/benchmark/runner";

const execution = (reportedCost: number | null): BenchmarkExecution => ({
  agent: "fixture",
  model: "fixture-model",
  provider: "fixture",
  initialMode: "GUIDED",
  finalMode: "STRICT",
  modeTransitions: [
    {
      from: "GUIDED",
      to: "STRICT",
      reason: "Evidence-backed fixture transition",
      signalSnapshotId: "snapshot",
    },
  ],
  signalSnapshots: [],
  inputTokens: 12,
  outputTokens: 8,
  cachedTokens: 2,
  reportedCost,
  latencyMs: 25,
  retryCount: 0,
  verificationAttempts: 1,
  repairAttempts: 0,
  verifierFailures: 0,
  verificationResult: "VERIFIED",
  filesChanged: ["src/example.ts"],
  modulesTouched: ["src"],
  contextExpansion: 1,
  orchestrationOverheadMs: 3,
});

describe("BenchmarkRunner", () => {
  it("compares native and adaptive execution without converting unknown cost to zero", async () => {
    const executors: BenchmarkExecutor[] = [
      { strategy: "NATIVE", execute: async () => execution(null) },
      { strategy: "MAF_ADAPTIVE", execute: async () => execution(0.25) },
    ];
    const runner = new BenchmarkRunner();
    const report = await runner.compare(
      { id: "task", prompt: "Fix the fixture", expectedVerification: "npm test" },
      executors,
    );
    expect(report.metrics).toEqual({
      sampleCount: 2,
      verifiedSuccessRate: 1,
      costPerVerifiedSuccess: 0.25,
      verifiedRunsWithKnownCost: 1,
    });
    expect(report.samples[0]).toMatchObject({
      strategy: "NATIVE",
      reportedCost: null,
      costStatus: "UNKNOWN",
    });
    const serialized = runner.serialize(report);
    expect(serialized).toContain('"reportedCost": null');
    expect(JSON.parse(serialized)).toMatchObject({ metrics: { verifiedSuccessRate: 1 } });
  });
});
