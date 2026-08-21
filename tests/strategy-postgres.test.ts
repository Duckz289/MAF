import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectIdentity } from "../src/domain/project-identity";
import {
  strategyAllocationKey,
  strategyObservationBinding,
  type StrategyObservation,
} from "../src/domain/strategy";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";
import { PostgresRunStore } from "../src/infrastructure/postgres/store";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("M12 PostgreSQL strategy evidence", () => {
  const schema = `maf_strategy_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    for (const migration of (await readdir(path.resolve("migrations"))).toSorted()) {
      if (migration.endsWith(".sql"))
        await pool.query(await readFile(path.resolve("migrations", migration), "utf8"));
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("migration 007 round-trips store-bound verified evidence", async () => {
    const taskId = randomUUID();
    const runId = randomUUID();
    const candidateId = randomUUID();
    const timestamp = "2026-08-21T00:00:00.000Z";
    const repositoryPath = "/strategy-fixture";
    const task: Task = {
      id: taskId,
      prompt: "fixture",
      repositoryPath,
      revision: "HEAD",
      createdAt: timestamp,
      verification: { command: "npm test" },
      qualityPreference: "HIGH",
    };
    const run: Run = {
      id: runId,
      taskId,
      state: "COMPLETED",
      executionMode: "GUIDED",
      desiredMode: "GUIDED",
      effectiveMode: "GUIDED",
      verificationState: "VERIFIED",
      trustState: "DURABLE_VERIFIED",
      agent: "fixture-adapter",
      model: "fixture-model",
      provider: "fixture-provider",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      changedFiles: [],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
      strategyEvidenceBinding: {
        projectId: projectIdentity(repositoryPath),
        taskClass: "checks:CORRECTNESS",
        riskProfile: "RD:LOW",
        qualityRequirement: "HIGH",
        reviewPolicy: "NONE",
      },
      strategyObservationBinding: {
        id: "placeholder",
        timestamp,
        verifiedSuccess: true,
        costUsd: null,
        latencyMs: 1,
        retries: 0,
        qualityOutcome: "PASS",
        security: "NOT_REQUIRED",
        performance: "NOT_REQUIRED",
        resilience: "PASS",
        healthEffect: "STABLE",
        evidenceBasis: "RUN_STORE_VERIFIED",
      },
    };
    const store = new PostgresRunStore(pool);
    await store.createTask(task);
    await store.createRun(run);
    await store.addArtifact({
      id: candidateId,
      runId,
      kind: "DIFF",
      uri: "sandbox://fixture.patch",
      digest: "a".repeat(64),
      metadata: {},
      createdAt: timestamp,
    });
    await store.addVerification({
      id: randomUUID(),
      runId,
      type: "command",
      state: "VERIFIED",
      output: "ok",
      startedAt: timestamp,
      completedAt: timestamp,
      candidateId,
    });
    const observation: StrategyObservation = {
      id: randomUUID(),
      timestamp,
      scope: {
        projectId: projectIdentity(repositoryPath),
        taskClass: "checks:CORRECTNESS",
        riskProfile: "RD:LOW",
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
      runId,
      candidateId,
      candidateDigest: "a".repeat(64),
      verifiedSuccess: true,
      trustState: "DURABLE_VERIFIED",
      costUsd: null,
      latencyMs: 1,
      retries: 0,
      qualityOutcome: "PASS",
      security: "NOT_REQUIRED",
      performance: "NOT_REQUIRED",
      resilience: "PASS",
      healthEffect: "STABLE",
      source: "RUN",
      evidenceBasis: "RUN_STORE_VERIFIED",
    };
    run.strategyObservationBinding = strategyObservationBinding(observation);
    await store.updateRun(run);
    await expect(
      store.saveStrategyObservation({
        ...observation,
        id: randomUUID(),
        timestamp: "2020-01-01T00:00:00.000Z",
        costUsd: 0,
        retries: 4,
        security: "PASS",
      }),
    ).rejects.toThrow(/not bound/u);
    await store.saveStrategyObservation(observation);
    expect(await store.listStrategyObservations(observation.scope.projectId)).toEqual([
      observation,
    ]);
    await expect(
      store.saveStrategyObservation({ ...observation, id: randomUUID() }),
    ).rejects.toThrow();
    const allocationKey = strategyAllocationKey(observation.scope, observation.strategy);
    expect(await store.allocateStrategyCanaryOrdinal(allocationKey)).toBe(0);
    expect(await store.allocateStrategyCanaryOrdinal(allocationKey)).toBe(1);

    const failedRunId = randomUUID();
    const failedCandidateId = randomUUID();
    const failedRun: Run = {
      ...run,
      id: failedRunId,
      state: "FAILED",
      verificationState: "QUARANTINED",
      trustState: "PROPOSED",
    };
    await store.createRun(failedRun);
    await store.addArtifact({
      id: failedCandidateId,
      runId: failedRunId,
      kind: "DIFF",
      uri: "sandbox://failed.patch",
      digest: "b".repeat(64),
      metadata: {},
      createdAt: timestamp,
    });
    await store.addVerification({
      id: randomUUID(),
      runId: failedRunId,
      type: "command",
      state: "QUARANTINED",
      output: "failed",
      startedAt: timestamp,
      completedAt: timestamp,
      candidateId: failedCandidateId,
    });
    const failedObservation: StrategyObservation = {
      ...observation,
      id: randomUUID(),
      runId: failedRunId,
      candidateId: failedCandidateId,
      candidateDigest: "b".repeat(64),
      verifiedSuccess: false,
      trustState: "PROPOSED",
      qualityOutcome: "FAIL",
      security: "NOT_CHECKED",
      performance: "NOT_CHECKED",
      resilience: "NOT_CHECKED",
      healthEffect: "UNKNOWN",
      evidenceBasis: "RUN_STORE_TERMINAL",
    };
    failedRun.strategyObservationBinding = strategyObservationBinding(failedObservation);
    await store.updateRun(failedRun);
    await store.saveStrategyObservation(failedObservation);
    expect(await store.listStrategyObservations(observation.scope.projectId)).toHaveLength(2);
  });
});
