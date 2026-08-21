import { describe, expect, it } from "vitest";
import {
  type BenchmarkExecution,
  type BenchmarkExecutor,
  BenchmarkRunner,
} from "../src/benchmark/runner";
import type { StrategyIdentity } from "../src/domain/strategy";

const execution = (
  reportedCost: number | null,
  overrides: Partial<BenchmarkExecution> = {},
): BenchmarkExecution => ({
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
  ...overrides,
});

describe("BenchmarkRunner", () => {
  it("compares native and adaptive execution without converting unknown cost to zero", async () => {
    const executors: BenchmarkExecutor[] = [
      { strategy: "NATIVE", execute: async () => execution(null) },
      { strategy: "MAF_ADAPTIVE", execute: async () => execution(0.25) },
    ];
    const runner = new BenchmarkRunner();
    const report = await runner.compare(
      {
        id: "task",
        prompt: "Fix the fixture",
        expectedVerification: "npm test",
      },
      executors,
    );
    expect(report.metrics).toEqual({
      sampleCount: 2,
      verifiedSuccessRate: 1,
      costPerVerifiedSuccess: 0.25,
      verifiedRunsWithKnownCost: 1,
    });
    expect(report.strategyEvidence).toEqual([]);
    expect(report.samples[0]).toMatchObject({
      strategy: "NATIVE",
      reportedCost: null,
      costStatus: "UNKNOWN",
    });
    const serialized = runner.serialize(report);
    expect(serialized).toContain('"reportedCost": null');
    expect(JSON.parse(serialized)).toMatchObject({
      metrics: { verifiedSuccessRate: 1 },
    });
  });

  it("emits scoped shadow evidence with full strategy identity", async () => {
    const identity = (baseline: StrategyIdentity["baseline"]): StrategyIdentity => ({
      adapter: "fixture",
      model: baseline === "NATIVE_FRONTIER" ? "frontier" : "challenger",
      provider: "fixture",
      executionMode: baseline === "NATIVE_FRONTIER" ? "NATIVE" : "GUIDED",
      qualityPreference: "HIGH",
      verificationProfile: "fixture-command",
      reviewPolicy: "NONE",
      baseline,
    });
    const report = await new BenchmarkRunner().compare(
      {
        id: "scoped-task",
        prompt: "Fix the fixture",
        expectedVerification: "npm test",
        strategyScope: {
          projectId: `project-${"a".repeat(64)}`,
          taskClass: "mechanical",
          riskProfile: "low",
          qualityRequirement: "HIGH",
        },
      },
      [
        {
          strategy: "NATIVE",
          identity: identity("NATIVE_FRONTIER"),
          execute: async () =>
            execution(null, {
              model: "frontier",
              finalMode: "NATIVE",
              initialMode: "NATIVE",
            }),
        },
        {
          strategy: "MAF_ADAPTIVE",
          identity: identity("CHALLENGER"),
          execute: async () => execution(0.25, { model: "challenger", finalMode: "GUIDED" }),
        },
      ],
    );
    expect(report.strategyEvidence).toHaveLength(2);
    expect(report.strategyEvidence[0]).toMatchObject({
      source: "BENCHMARK_SHADOW",
      costUsd: null,
      trustState: "NATIVE_VERIFIED",
      strategy: { baseline: "NATIVE_FRONTIER" },
    });
  });

  it("normalizes an omitted cost to UNKNOWN and rejects invalid executor metrics", async () => {
    const runner = new BenchmarkRunner();
    const omitted = {
      ...execution(0.25),
      reportedCost: undefined,
    } as unknown as BenchmarkExecution;
    const report = await runner.compare(
      { id: "unknown-cost", prompt: "x", expectedVerification: "test" },
      [
        { strategy: "NATIVE", execute: async () => omitted },
        { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
      ],
    );
    expect(report.metrics.verifiedRunsWithKnownCost).toBe(0);
    expect(report.metrics.costPerVerifiedSuccess).toBeNull();
    await expect(
      runner.compare({ id: "bad-cost", prompt: "x", expectedVerification: "test" }, [
        { strategy: "NATIVE", execute: async () => execution(-1) },
        { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
      ]),
    ).rejects.toThrow(/cost/u);
  });

  it("rejects benchmark identities whose baseline role contradicts the variant", async () => {
    const wrongNative: StrategyIdentity = {
      adapter: "fixture",
      model: "fixture-model",
      provider: "fixture",
      executionMode: "NATIVE",
      qualityPreference: "HIGH",
      verificationProfile: "fixture-command",
      reviewPolicy: "NONE",
      baseline: "CHALLENGER",
    };
    await expect(
      new BenchmarkRunner().compare(
        {
          id: "roles",
          prompt: "x",
          expectedVerification: "test",
          strategyScope: {
            projectId: `project-${"a".repeat(64)}`,
            taskClass: "mechanical",
            riskProfile: "low",
            qualityRequirement: "HIGH",
          },
        },
        [
          {
            strategy: "NATIVE",
            identity: wrongNative,
            execute: async () => execution(null, { initialMode: "NATIVE", finalMode: "NATIVE" }),
          },
          { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
        ],
      ),
    ).rejects.toThrow(/identity/u);
  });
});
