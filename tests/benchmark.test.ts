import { describe, expect, it } from "vitest";
import {
  type BenchmarkExecution,
  type BenchmarkExecutor,
  BenchmarkRunner,
  benchmarkFamilies,
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
  finalMode: "GUIDED",
  modeTransitions: [],
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

const suiteIdentity = (strategy: BenchmarkExecutor["strategy"]): StrategyIdentity => ({
  adapter: "fixture",
  model: "fixture-model",
  provider: "fixture",
  executionMode: strategy === "NATIVE" ? "NATIVE" : "GUIDED",
  qualityPreference: "BALANCED",
  verificationProfile: "fixture",
  reviewPolicy: "NONE",
  baseline: strategy === "NATIVE" ? "NATIVE_FRONTIER" : "CHALLENGER",
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
      selfReportedVerifiedRate: 1,
      meanCostOfVerifiedSuccessesUsd: 0.25,
      selfReportedSuccessesWithKnownCost: 1,
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
      metrics: { selfReportedVerifiedRate: 1 },
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
    expect(report.metrics.selfReportedSuccessesWithKnownCost).toBe(0);
    expect(report.metrics.meanCostOfVerifiedSuccessesUsd).toBeNull();
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

  it("runs all ten families sequentially and emits non-causal N+1 changeability deltas", async () => {
    const tasks = benchmarkFamilies.map((family, index) => ({
      id: `checkpoint-${index + 1}`,
      prompt: family,
      expectedVerification: "test",
      family,
      sequence: { id: "evolution", checkpoint: index + 1 },
      ...(index === 0
        ? {
            changeability: {
              comparisonClass: "comparable",
              workload: "same bounded fixture edit",
              role: "EVOLUTION" as const,
            },
          }
        : index === 9
          ? {
              changeability: {
                comparisonClass: "comparable",
                workload: "same bounded fixture edit",
                role: "N_PLUS_ONE" as const,
              },
            }
          : {}),
    }));
    const seen: string[] = [];
    const stateByStrategy = new Map<string, string>();
    const executors: BenchmarkExecutor[] = ["NATIVE", "MAF_ADAPTIVE"].map((strategy) => ({
      strategy: strategy as BenchmarkExecutor["strategy"],
      identity: suiteIdentity(strategy as BenchmarkExecutor["strategy"]),
      execute: async (task) => {
        seen.push(`${strategy}:${task.id}`);
        const checkpoint = task.sequence?.checkpoint ?? 0;
        const resultStateDigest = checkpoint.toString(16).padStart(64, "0");
        const baseStateDigest = stateByStrategy.get(strategy) ?? null;
        stateByStrategy.set(strategy, resultStateDigest);
        return execution(null, {
          ...(strategy === "NATIVE" ? { initialMode: "NATIVE", finalMode: "NATIVE" } : {}),
          inputTokens: task.id.endsWith("10") ? 20 : 12,
          toolCalls: task.id.endsWith("10") ? 5 : 3,
          sequenceEvidence: {
            sequenceId: task.sequence?.id ?? "missing",
            checkpoint,
            baseStateDigest,
            resultStateDigest,
            candidateStateDigest: resultStateDigest,
            verifiedStateDigest: resultStateDigest,
          },
          runId: `run-${strategy}-${checkpoint}`,
          candidateId: `candidate-${strategy}-${checkpoint}`,
          scenarioEvidence: {
            family: task.family ?? "SMALL_MECHANICAL",
            outcome: "EXERCISED",
            checks: ["deterministic unit fixture"],
          },
        });
      },
    }));
    const report = await new BenchmarkRunner().runSuite(tasks, executors);
    expect(report.coverage).toEqual({
      evidenceBasis: "EXECUTOR_ASSERTED_CHECKS",
      declaredFamilies: benchmarkFamilies,
      exercisedFamilies: benchmarkFamilies,
      missingFamilies: [],
      complete: true,
    });
    expect(report.longHorizon).toEqual([
      {
        sequenceId: "evolution",
        checkpoints: 10,
        firstCheckpoint: 1,
        lastCheckpoint: 10,
        chainValidated: true,
        sufficient: true,
      },
    ]);
    expect(report.changeability).toHaveLength(2);
    expect(report.changeability[0]).toMatchObject({
      beforeTaskId: "checkpoint-1",
      nPlusOneTaskId: "checkpoint-10",
      causalClaim: "NONE",
      deltas: { tokens: 8, toolCalls: 2 },
    });
    expect(seen).toHaveLength(20);
    expect(seen.slice(0, 4)).toEqual([
      "NATIVE:checkpoint-1",
      "MAF_ADAPTIVE:checkpoint-1",
      "NATIVE:checkpoint-2",
      "MAF_ADAPTIVE:checkpoint-2",
    ]);
  });

  it("rejects long-horizon labels without a contiguous state chain", async () => {
    const task = {
      id: "checkpoint-1",
      prompt: "x",
      expectedVerification: "test",
      sequence: { id: "evolution", checkpoint: 1 },
    };
    await expect(
      new BenchmarkRunner().runSuite(
        [task],
        [
          {
            strategy: "NATIVE",
            identity: suiteIdentity("NATIVE"),
            execute: async () => execution(null, { initialMode: "NATIVE", finalMode: "NATIVE" }),
          },
          {
            strategy: "MAF_ADAPTIVE",
            identity: suiteIdentity("MAF_ADAPTIVE"),
            execute: async () => execution(null),
          },
        ],
      ),
    ).rejects.toThrow(/state-chain/u);

    await expect(
      new BenchmarkRunner().runSuite(
        [{ ...task, sequence: { id: "evolution", checkpoint: 2 } }],
        [
          {
            strategy: "NATIVE",
            identity: suiteIdentity("NATIVE"),
            execute: async () => execution(null, { initialMode: "NATIVE", finalMode: "NATIVE" }),
          },
          {
            strategy: "MAF_ADAPTIVE",
            identity: suiteIdentity("MAF_ADAPTIVE"),
            execute: async () => execution(null),
          },
        ],
      ),
    ).rejects.toThrow(/expected checkpoint 1/u);
  });

  it("rejects impossible verification metrics and discontinuous mode transitions", async () => {
    const runner = new BenchmarkRunner();
    await expect(
      runner.compare({ id: "impossible", prompt: "x", expectedVerification: "test" }, [
        {
          strategy: "NATIVE",
          execute: async () =>
            execution(null, {
              initialMode: "NATIVE",
              finalMode: "NATIVE",
              verificationAttempts: 0,
            }),
        },
        { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
      ]),
    ).rejects.toThrow(/successful verification/u);
    await expect(
      runner.compare({ id: "transition", prompt: "x", expectedVerification: "test" }, [
        {
          strategy: "NATIVE",
          execute: async () => execution(null, { initialMode: "NATIVE", finalMode: "NATIVE" }),
        },
        {
          strategy: "MAF_ADAPTIVE",
          execute: async () =>
            execution(null, {
              finalMode: "STRICT",
              modeTransitions: [{ from: "SOLO_NATIVE", to: "STRICT", reason: "" }],
            }),
        },
      ]),
    ).rejects.toThrow(/contiguous chain/u);

    await expect(
      runner.compare({ id: "cross-run", prompt: "x", expectedVerification: "test" }, [
        {
          strategy: "NATIVE",
          execute: async () =>
            execution(null, {
              initialMode: "NATIVE",
              finalMode: "NATIVE",
              runId: "run-a",
              signalSnapshots: [
                {
                  id: "snapshot-a",
                  runId: "run-b",
                  sequence: 1,
                  checkpoint: "test",
                  timestamp: "2026-08-21T00:00:00.000Z",
                  signals: {},
                  evidence: [],
                },
              ],
            }),
        },
        { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
      ]),
    ).rejects.toThrow(/not bound to the execution run/u);

    const leaked = {
      ...execution(null, { initialMode: "NATIVE", finalMode: "NATIVE" }),
      secretToken: `ghp_${"a".repeat(36)}`,
    } as BenchmarkExecution;
    const projected = await runner.compare(
      { id: "projection", prompt: "x", expectedVerification: "test" },
      [
        { strategy: "NATIVE", execute: async () => leaked },
        { strategy: "MAF_ADAPTIVE", execute: async () => execution(null) },
      ],
    );
    expect(projected.samples[0]).not.toHaveProperty("secretToken");
  });

  it("rejects constant-state evolution and an orphan N+1 comparison", async () => {
    const digest = "a".repeat(64);
    const executors = (constant: boolean): BenchmarkExecutor[] =>
      (["NATIVE", "MAF_ADAPTIVE"] as const).map((strategy) => ({
        strategy,
        identity: suiteIdentity(strategy),
        execute: async (task) => {
          const checkpoint = task.sequence?.checkpoint ?? 1;
          const resultStateDigest = constant ? digest : checkpoint.toString(16).padStart(64, "0");
          return execution(null, {
            ...(strategy === "NATIVE" ? { initialMode: "NATIVE", finalMode: "NATIVE" } : {}),
            runId: `run-${strategy}-${checkpoint}`,
            candidateId: `candidate-${strategy}-${checkpoint}`,
            sequenceEvidence: {
              sequenceId: task.sequence?.id ?? "evolution",
              checkpoint,
              baseStateDigest: checkpoint === 1 ? null : digest,
              resultStateDigest,
              candidateStateDigest: resultStateDigest,
              verifiedStateDigest: resultStateDigest,
            },
          });
        },
      }));
    const baseTask = {
      prompt: "x",
      expectedVerification: "test",
      sequence: { id: "evolution", checkpoint: 1 },
    };
    await expect(
      new BenchmarkRunner().runSuite(
        [
          { ...baseTask, id: "one" },
          { ...baseTask, id: "two", sequence: { id: "evolution", checkpoint: 2 } },
        ],
        executors(true),
      ),
    ).rejects.toThrow(/state-chain/u);
    const reuseExecutors: BenchmarkExecutor[] = (["NATIVE", "MAF_ADAPTIVE"] as const).map(
      (strategy) => ({
        strategy,
        identity: suiteIdentity(strategy),
        execute: async (task) => {
          const checkpoint = task.sequence?.checkpoint ?? 1;
          const resultStateDigest = checkpoint.toString(16).padStart(64, "0");
          return execution(null, {
            ...(strategy === "NATIVE" ? { initialMode: "NATIVE", finalMode: "NATIVE" } : {}),
            runId: checkpoint === 3 ? `run-${strategy}-1` : `run-${strategy}-${checkpoint}`,
            candidateId:
              checkpoint === 3 ? `candidate-${strategy}-1` : `candidate-${strategy}-${checkpoint}`,
            sequenceEvidence: {
              sequenceId: "evolution",
              checkpoint,
              baseStateDigest:
                checkpoint === 1 ? null : (checkpoint - 1).toString(16).padStart(64, "0"),
              resultStateDigest,
              candidateStateDigest: resultStateDigest,
              verifiedStateDigest: resultStateDigest,
            },
          });
        },
      }),
    );
    await expect(
      new BenchmarkRunner().runSuite(
        [1, 2, 3].map((checkpoint) => ({
          ...baseTask,
          id: `reuse-${checkpoint}`,
          sequence: { id: "evolution", checkpoint },
        })),
        reuseExecutors,
      ),
    ).rejects.toThrow(/reused a prior run or candidate/u);
    await expect(
      new BenchmarkRunner().runSuite(
        [
          {
            ...baseTask,
            id: "orphan",
            changeability: {
              comparisonClass: "same",
              workload: "same edit",
              role: "N_PLUS_ONE" as const,
            },
          },
        ],
        executors(false),
      ),
    ).rejects.toThrow(/lacks a bound prior/u);
  });

  it("does not treat a manifest family label as executed coverage", async () => {
    const digest = "b".repeat(64);
    const report = await new BenchmarkRunner().runSuite(
      [
        {
          id: "label-only",
          prompt: "x",
          expectedVerification: "test",
          family: "SMALL_MECHANICAL",
          sequence: { id: "evolution", checkpoint: 1 },
        },
      ],
      (["NATIVE", "MAF_ADAPTIVE"] as const).map((strategy) => ({
        strategy,
        identity: suiteIdentity(strategy),
        execute: async () =>
          execution(null, {
            ...(strategy === "NATIVE" ? { initialMode: "NATIVE", finalMode: "NATIVE" } : {}),
            runId: `run-${strategy}`,
            candidateId: `candidate-${strategy}`,
            sequenceEvidence: {
              sequenceId: "evolution",
              checkpoint: 1,
              baseStateDigest: null,
              resultStateDigest: digest,
              candidateStateDigest: digest,
              verifiedStateDigest: digest,
            },
          }),
      })),
    );
    expect(report.coverage).toMatchObject({
      declaredFamilies: ["SMALL_MECHANICAL"],
      exercisedFamilies: [],
      complete: false,
    });
  });
});
