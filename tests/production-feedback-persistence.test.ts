import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deliveryHandoffDigest,
  type CiEvidence,
  type DeliveryHandoff,
} from "../src/domain/delivery";
import type { RunStore } from "../src/domain/ports";
import { projectIdentity } from "../src/domain/project-identity";
import type { ProductionFeedback } from "../src/domain/production-feedback";
import { strategyObservationBinding, type StrategyObservation } from "../src/domain/strategy";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { PostgresRunStore } from "../src/infrastructure/postgres/store";

const seed = async (store: RunStore) => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const task: Task = {
    id: randomUUID(),
    prompt: "release",
    repositoryPath: "/production-feedback-fixture",
    revision: "a".repeat(40),
    createdAt: timestamp,
    verification: { command: "npm test" },
    qualityPreference: "HIGH",
  };
  const projectId = projectIdentity(task.repositoryPath);
  const scope = {
    projectId,
    taskClass: "checks:CORRECTNESS",
    riskProfile: "RD:LOW",
    qualityRequirement: "HIGH" as const,
  };
  const strategy = {
    adapter: "agent",
    model: "model",
    provider: "provider",
    executionMode: "GUIDED" as const,
    qualityPreference: "HIGH" as const,
    verificationProfile: "COMMAND",
    reviewPolicy: "NONE" as const,
    baseline: "CHALLENGER" as const,
  };
  const run: Run = {
    id: randomUUID(),
    taskId: task.id,
    state: "COMPLETED",
    executionMode: "GUIDED",
    desiredMode: "GUIDED",
    effectiveMode: "GUIDED",
    verificationState: "VERIFIED",
    trustState: "MERGE_ELIGIBLE",
    agent: strategy.adapter,
    model: strategy.model,
    provider: strategy.provider,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    changedFiles: ["src/index.ts"],
    cost: emptyCost(),
    usage: emptyUsage(),
    retryCount: 0,
    strategyEvidenceBinding: {
      projectId,
      taskClass: scope.taskClass,
      riskProfile: scope.riskProfile,
      qualityRequirement: "HIGH",
      reviewPolicy: "NONE",
    },
  };
  const candidateId = randomUUID();
  const verificationId = randomUUID();
  const observation: StrategyObservation = {
    id: randomUUID(),
    timestamp,
    scope,
    strategy,
    runId: run.id,
    candidateId,
    candidateDigest: "b".repeat(64),
    verifiedSuccess: true,
    trustState: "MERGE_ELIGIBLE",
    costUsd: null,
    latencyMs: 1,
    retries: 0,
    qualityOutcome: "PASS",
    security: "PASS",
    performance: "NOT_REQUIRED",
    resilience: "NOT_REQUIRED",
    healthEffect: "STABLE",
    source: "RUN",
    evidenceBasis: "RUN_STORE_VERIFIED",
  };
  run.strategyObservationBinding = strategyObservationBinding(observation);
  const handoff: DeliveryHandoff = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    runId: run.id,
    candidateId,
    candidateDigest: observation.candidateDigest ?? "",
    baseRevision: task.revision,
    headRevision: null,
    changedFiles: run.changedFiles,
    verification: { id: verificationId, state: "VERIFIED" },
    trustState: "MERGE_ELIGIBLE",
    quality: Object.fromEntries(
      [
        "Correctness",
        "Architecture",
        "Maintainability",
        "Security",
        "Performance",
        "Resilience",
        "TestQuality",
        "DebtDelta",
      ].map((dimension) => [dimension, { state: "PASS", provenance: "DETERMINISTIC" }]),
    ) as DeliveryHandoff["quality"],
    knownWarnings: [],
    evidenceRefs: [`artifact:${candidateId}`, `verification:${verificationId}`, `run:${run.id}`],
    budget: { mode: "ADVISORY", limitUsd: null, recordedCostUsd: 0 },
    policy: { ciRequired: true, riskLevel: "LOW", autoMergeAllowed: false },
    candidateQuality: "READY",
    createdAt: timestamp,
  };
  run.deliveryHandoffBinding = {
    handoffId: handoff.id,
    candidateId,
    candidateDigest: handoff.candidateDigest,
    payloadDigest: deliveryHandoffDigest(handoff),
  };
  await store.createTask(task);
  await store.createRun(run);
  await store.addArtifact({
    id: candidateId,
    runId: run.id,
    kind: "DIFF",
    uri: "sandbox://candidate",
    digest: handoff.candidateDigest,
    metadata: { baseRevision: task.revision },
    createdAt: timestamp,
  });
  await store.addVerification({
    id: verificationId,
    runId: run.id,
    type: "command",
    state: "VERIFIED",
    output: "ok",
    startedAt: timestamp,
    completedAt: timestamp,
    candidateId,
  });
  await store.saveStrategyObservation(observation);
  await store.saveDeliveryHandoff(handoff);
  const ci: CiEvidence = {
    schemaVersion: 1,
    id: randomUUID(),
    handoffId: handoff.id,
    provider: "github",
    externalRunId: "run-42",
    observedAt: timestamp,
    conclusion: "PASS",
    candidateId,
    candidateDigest: handoff.candidateDigest,
    baseRevision: handoff.baseRevision,
    headRevision: "c".repeat(40),
    checks: [{ name: "test", conclusion: "PASS" }],
    evidenceRef: "github:run-42",
  };
  await store.saveCiEvidence(ci);
  const feedback: ProductionFeedback = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    runId: run.id,
    candidateId,
    candidateDigest: handoff.candidateDigest,
    releaseRevision: ci.headRevision ?? "",
    strategy,
    scope,
    type: "INCIDENT",
    severity: "HIGH",
    observedAt: timestamp,
    source: {
      kind: "VERIFIED_OBSERVABILITY_ADAPTER",
      provider: "sentry",
      externalEventId: "event-1",
    },
    evidenceRef: "sentry:event-1",
  };
  return { store, feedback };
};

describe("M14 in-memory production feedback persistence", () => {
  it("binds feedback to the released candidate and exact strategy scope", async () => {
    const { store, feedback } = await seed(new InMemoryRunStore());
    await store.saveProductionFeedback(feedback);
    expect(await store.listProductionFeedback(feedback.projectId)).toEqual([feedback]);
    await expect(
      store.saveProductionFeedback({
        ...feedback,
        id: randomUUID(),
        source: { ...feedback.source, externalEventId: "stale" },
        scope: { ...feedback.scope, taskClass: "other" },
      }),
    ).rejects.toThrow(/released candidate and strategy/u);
  });

  it("does not evict sticky material evidence behind a project window", async () => {
    const { store, feedback } = await seed(new InMemoryRunStore());
    await store.saveProductionFeedback(feedback);
    for (let index = 0; index < 501; index += 1) {
      await store.saveProductionFeedback({
        ...feedback,
        id: randomUUID(),
        type: "ERROR_RATE_REGRESSION",
        severity: "LOW",
        observedAt: new Date(Date.parse(feedback.observedAt) + index + 1).toISOString(),
        source: { ...feedback.source, externalEventId: `routine-${index}` },
      });
    }
    const all = await store.listProductionFeedback(feedback.projectId);
    expect(all).toHaveLength(502);
    expect(all.some((item) => item.id === feedback.id && item.type === "INCIDENT")).toBe(true);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
describePostgres("M14 PostgreSQL production feedback persistence", () => {
  const schema = `maf_feedback_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of (await readdir(path.resolve("migrations"))).toSorted())
      if (migration.endsWith(".sql"))
        await pool.query(await readFile(path.resolve("migrations", migration), "utf8"));
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it("migration 009 round-trips exact release evidence and rejects scope repaint", async () => {
    const { store, feedback } = await seed(new PostgresRunStore(pool));
    await store.saveProductionFeedback(feedback);
    expect(await store.listProductionFeedback(feedback.projectId)).toEqual([feedback]);
    await expect(
      store.saveProductionFeedback({
        ...feedback,
        id: randomUUID(),
        source: { ...feedback.source, externalEventId: "stale" },
        scope: { ...feedback.scope, taskClass: "other" },
      }),
    ).rejects.toThrow(/released candidate/u);
    await pool.query(
      `UPDATE production_feedback SET payload=jsonb_set(payload, '{severity}', '"LOW"'::jsonb)
       WHERE id=$1`,
      [feedback.id],
    );
    await expect(store.listProductionFeedback(feedback.projectId)).rejects.toThrow(/row binding/u);
  });
});
