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
import { projectIdentity } from "../src/domain/project-identity";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";
import { PostgresRunStore } from "../src/infrastructure/postgres/store";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("M13 PostgreSQL delivery handoff", () => {
  const schema = `maf_delivery_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
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

  it("migration 008 binds handoff and CI evidence to the exact verified candidate", async () => {
    const timestamp = "2026-08-21T00:00:00.000Z";
    const task: Task = {
      id: randomUUID(),
      prompt: "delivery",
      repositoryPath: "/delivery-fixture",
      revision: "a".repeat(40),
      createdAt: timestamp,
      verification: { command: "npm test" },
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
      agent: "agent",
      model: "model",
      provider: "provider",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      changedFiles: ["src/index.ts"],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
    };
    const candidateId = randomUUID();
    const verificationId = randomUUID();
    const handoff: DeliveryHandoff = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId: projectIdentity(task.repositoryPath),
      runId: run.id,
      candidateId,
      candidateDigest: "b".repeat(64),
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
    const store = new PostgresRunStore(pool);
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
    await store.saveDeliveryHandoff(handoff);
    expect(await store.getDeliveryHandoff(run.id)).toEqual(handoff);

    const ci: CiEvidence = {
      schemaVersion: 1,
      id: randomUUID(),
      handoffId: handoff.id,
      provider: "github",
      externalRunId: "42",
      observedAt: timestamp,
      conclusion: "PENDING",
      candidateId,
      candidateDigest: handoff.candidateDigest,
      baseRevision: handoff.baseRevision,
      headRevision: null,
      checks: [{ name: "test", conclusion: "PENDING" }],
      evidenceRef: "github-actions:42",
    };
    await expect(
      store.saveCiEvidence({
        ...ci,
        id: randomUUID(),
        externalRunId: "poison-attempt",
        conclusion: "PASS",
        candidateId: randomUUID(),
        headRevision: "d".repeat(40),
        checks: [{ name: "test", conclusion: "PASS" }],
      }),
    ).rejects.toThrow(/stale/u);
    await store.saveCiEvidence(ci);
    const passed: CiEvidence = {
      ...ci,
      id: randomUUID(),
      observedAt: "2026-08-21T00:01:00.000Z",
      conclusion: "PASS",
      headRevision: "c".repeat(40),
      checks: [{ name: "test", conclusion: "PASS" }],
    };
    await store.saveCiEvidence(passed);
    expect(await store.listCiEvidence(handoff.id)).toEqual([ci, passed]);
    await expect(
      store.saveCiEvidence({
        ...passed,
        id: randomUUID(),
        observedAt: "2026-08-21T00:02:00.000Z",
        headRevision: "d".repeat(40),
      }),
    ).rejects.toThrow(/stale/u);
    await expect(
      store.saveCiEvidence({
        ...passed,
        id: randomUUID(),
        externalRunId: "different-run",
        observedAt: "2026-08-21T00:03:00.000Z",
        headRevision: "d".repeat(40),
      }),
    ).rejects.toThrow(/stale/u);
    await expect(
      store.saveCiEvidence({
        ...ci,
        id: randomUUID(),
        externalRunId: "43",
        candidateId: randomUUID(),
      }),
    ).rejects.toThrow(/stale/u);
  });
});
