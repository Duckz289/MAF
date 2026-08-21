import { describe, expect, it } from "vitest";

import { RunService } from "../src/application/run-service";
import type { RunStore } from "../src/domain/ports";
import { projectIdentity } from "../src/domain/project-identity";
import { strategyAllocationKey, type StrategyObservation } from "../src/domain/strategy";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";

const repositoryPath = process.cwd();
const digest = "a".repeat(64);

const register = async (store: InMemoryRunStore): Promise<StrategyObservation> => {
  const task: Task = {
    id: "task-strategy",
    prompt: "fixture",
    repositoryPath,
    revision: "HEAD",
    createdAt: "2026-08-21T00:00:00.000Z",
    verification: { command: "npm test" },
    qualityPreference: "HIGH",
  };
  const run: Run = {
    id: "run-strategy",
    taskId: task.id,
    state: "COMPLETED",
    executionMode: "GUIDED",
    desiredMode: "GUIDED",
    effectiveMode: "GUIDED",
    verificationState: "VERIFIED",
    trustState: "DURABLE_VERIFIED",
    agent: "fixture-adapter",
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
    completedAt: task.createdAt,
    changedFiles: ["src/example.ts"],
    cost: { ...emptyCost(), model: 0.2, total: 0.2 },
    usage: emptyUsage(),
    retryCount: 0,
    strategyEvidenceBinding: {
      projectId: projectIdentity(repositoryPath),
      taskClass: "checks:CORRECTNESS+RESILIENCE",
      riskProfile: "RD:LOW|CC:LOW",
      qualityRequirement: "HIGH",
      reviewPolicy: "NONE",
    },
    strategyObservationBinding: {
      id: "observation-strategy",
      timestamp: task.createdAt,
      verifiedSuccess: true,
      costUsd: 0.2,
      latencyMs: 100,
      retries: 0,
      qualityOutcome: "PASS",
      security: "NOT_REQUIRED",
      performance: "NOT_REQUIRED",
      resilience: "PASS",
      healthEffect: "STABLE",
      evidenceBasis: "RUN_STORE_VERIFIED",
    },
  };
  await store.createTask(task);
  await store.createRun(run);
  await store.addArtifact({
    id: "candidate-strategy",
    runId: run.id,
    kind: "DIFF",
    uri: "sandbox://fixture.patch",
    digest,
    metadata: { baseRevision: "b".repeat(40) },
    createdAt: task.createdAt,
  });
  await store.addVerification({
    id: "verification-strategy",
    runId: run.id,
    type: "command",
    state: "VERIFIED",
    output: "ok",
    startedAt: task.createdAt,
    completedAt: task.createdAt,
    candidateId: "candidate-strategy",
  });
  return {
    id: "observation-strategy",
    timestamp: task.createdAt,
    scope: {
      projectId: projectIdentity(repositoryPath),
      taskClass: "checks:CORRECTNESS+RESILIENCE",
      riskProfile: "RD:LOW|CC:LOW",
      qualityRequirement: "HIGH",
    },
    strategy: {
      adapter: run.agent,
      model: run.model,
      provider: run.provider,
      executionMode: run.effectiveMode,
      qualityPreference: "HIGH",
      verificationProfile: "COMMAND",
      reviewPolicy: "NONE",
      baseline: "CHALLENGER",
    },
    runId: run.id,
    candidateId: "candidate-strategy",
    candidateDigest: digest,
    verifiedSuccess: true,
    trustState: "DURABLE_VERIFIED",
    costUsd: 0.2,
    latencyMs: 100,
    retries: 0,
    qualityOutcome: "PASS",
    security: "NOT_REQUIRED",
    performance: "NOT_REQUIRED",
    resilience: "PASS",
    healthEffect: "STABLE",
    source: "RUN",
    evidenceBasis: "RUN_STORE_VERIFIED",
  };
};

describe("M12 strategy persistence binding", () => {
  it("round-trips only evidence bound to the verified run, candidate, project and identity", async () => {
    const store = new InMemoryRunStore();
    const observation = await register(store);
    await expect(
      store.saveStrategyObservation({
        ...observation,
        candidateDigest: "f".repeat(64),
      }),
    ).rejects.toThrow(/not bound/u);
    await expect(
      store.saveStrategyObservation({
        ...observation,
        strategy: { ...observation.strategy, model: "forged" },
      }),
    ).rejects.toThrow(/not bound/u);
    await expect(
      store.saveStrategyObservation({
        ...observation,
        timestamp: "2020-01-01T00:00:00.000Z",
        costUsd: 0,
        retries: 3,
        security: "PASS",
      }),
    ).rejects.toThrow(/not bound/u);
    await store.saveStrategyObservation(observation);
    expect(await store.listStrategyObservations(observation.scope.projectId)).toEqual([
      observation,
    ]);
    expect(await store.listStrategyObservations(observation.scope.projectId, 0)).toEqual([]);
    await expect(
      store.saveStrategyObservation({
        ...observation,
        id: "forged-scope",
        scope: { ...observation.scope, taskClass: "forged-class" },
      }),
    ).rejects.toThrow(/not bound/u);
  });

  it("allocates canary ordinals monotonically instead of accepting caller-selected slots", async () => {
    const store = new InMemoryRunStore();
    const observation = await register(store);
    const allocationKey = strategyAllocationKey(observation.scope, observation.strategy);
    const ordinals: number[] = [];
    for (let index = 0; index < 20; index += 1)
      ordinals.push(await store.allocateStrategyCanaryOrdinal(allocationKey));
    expect(ordinals).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(ordinals.filter((ordinal) => ordinal % 10 === 0)).toHaveLength(2);
    const otherKey = strategyAllocationKey(
      { ...observation.scope, taskClass: "different-class" },
      observation.strategy,
    );
    expect(await store.allocateStrategyCanaryOrdinal(otherKey)).toBe(0);
  });

  it("uses the store allocator to enforce the 10% canary ceiling", async () => {
    const fixtureStore = new InMemoryRunStore();
    const base = await register(fixtureStore);
    const observations = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      id: `canary-${index}`,
      runId: `canary-run-${index}`,
      candidateId: `canary-candidate-${index}`,
      candidateDigest: index.toString(16).padStart(64, "0"),
    }));
    let nextOrdinal = 0;
    const selectionStore = {
      listStrategyObservations: async () => observations,
      allocateStrategyCanaryOrdinal: async () => nextOrdinal++,
    } as unknown as RunStore;
    const service = new RunService({ store: selectionStore } as never);
    const native = {
      ...base.strategy,
      model: "native-frontier",
      executionMode: "NATIVE" as const,
      baseline: "NATIVE_FRONTIER" as const,
    };
    let challengerSelections = 0;
    for (let index = 0; index < 20; index += 1) {
      const selection = await service.selectExecutionStrategy(base.scope, native, base.strategy);
      if (selection.selected.baseline === "CHALLENGER") challengerSelections += 1;
    }
    expect(challengerSelections).toBe(2);
    expect(nextOrdinal).toBe(20);
  });
});
