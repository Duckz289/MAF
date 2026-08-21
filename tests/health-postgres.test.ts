import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveChangeHealth, type HealthSample } from "../src/domain/health";
import { projectIdentity } from "../src/domain/project-identity";
import { PostgresRunStore } from "../src/infrastructure/postgres/store";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("M11 PostgreSQL health ledger", () => {
  const schema = `maf_health_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const migrations = (await readdir(path.resolve("migrations")))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
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

  it("migration 006 creates project/run-bound append-only schema", async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'health_samples'
       ORDER BY ordinal_position`,
      [schema],
    );
    expect(columns.rows).toMatchObject([
      { column_name: "id", is_nullable: "NO" },
      { column_name: "project_id", is_nullable: "NO" },
      { column_name: "revision", is_nullable: "NO" },
      { column_name: "timestamp", is_nullable: "NO" },
      { column_name: "run_id", is_nullable: "NO" },
      { column_name: "candidate_id", is_nullable: "NO" },
      { column_name: "candidate_digest", is_nullable: "NO" },
      { column_name: "evidence_basis", is_nullable: "NO" },
      { column_name: "payload", is_nullable: "NO" },
    ]);
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'health_samples'`,
      [schema],
    );
    expect(
      indexes.rows.some((row) => row.indexdef.includes('project_id, "timestamp", run_id')),
    ).toBe(true);
    expect(
      indexes.rows.some(
        (row) => row.indexdef.includes("UNIQUE") && row.indexdef.includes("run_id"),
      ),
    ).toBe(true);
  });

  it("round-trips ordered project windows and rejects payload identity drift", async () => {
    const taskId = randomUUID();
    const taskBId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [runA3, runA1, runB, runA2] = runIds;
    if (!runA3 || !runA1 || !runB || !runA2) throw new Error("run fixtures were not created");
    const now = "2026-08-21T00:00:00.000Z";
    await pool.query(
      `INSERT INTO tasks(id, repository_path, revision, prompt, payload, created_at)
       VALUES ($1, '/fixture', 'HEAD', 'fixture', '{}'::jsonb, $2)`,
      [taskId, now],
    );
    await pool.query(
      `INSERT INTO tasks(id, repository_path, revision, prompt, payload, created_at)
       VALUES ($1, '/fixture-b', 'HEAD', 'fixture', '{}'::jsonb, $2)`,
      [taskBId, now],
    );
    for (const runId of runIds) {
      await pool.query(
        `INSERT INTO runs(
           id, task_id, state, execution_mode, verification_state, payload, created_at, updated_at
         ) VALUES ($1, $2, 'COMPLETED', 'GUIDED', 'VERIFIED', '{}'::jsonb, $3, $3)`,
        [runId, runId === runB ? taskBId : taskId, now],
      );
    }
    const candidateByRun = new Map<string, string>(runIds.map((runId) => [runId, randomUUID()]));
    const revisionByRun = new Map<string, string>(
      runIds.map((runId, index) => [runId, String(index + 1).repeat(40)]),
    );
    for (const runId of runIds) {
      const candidateId = candidateByRun.get(runId);
      await pool.query(
        `INSERT INTO artifacts(id, run_id, kind, uri, digest, metadata, created_at)
         VALUES ($1, $2, 'DIFF', 'sandbox://fixture.patch', $3, $4, $5)`,
        [candidateId, runId, "a".repeat(64), { baseRevision: revisionByRun.get(runId) }, now],
      );
      await pool.query(
        `INSERT INTO verifications(
           id, run_id, type, state, output, started_at, completed_at, attempt, candidate_id
         ) VALUES ($1, $2, 'command', 'VERIFIED', 'ok', $3, $3, 1, $4)`,
        [randomUUID(), runId, now, candidateId],
      );
    }
    const store = new PostgresRunStore(pool);
    const sample = (
      runId: string,
      timestamp: string,
      revision: string,
      repositoryPath = "/fixture",
    ): HealthSample => ({
      projectId: projectIdentity(repositoryPath),
      runId,
      timestamp,
      revision,
      candidateId: candidateByRun.get(runId) ?? "missing",
      candidateDigest: "a".repeat(64),
      evidenceBasis: "VERIFIED_CANDIDATE",
      structuralBasis: "BASE_REVISION",
      changeBasis: "VERIFIED_CANDIDATE_DIFF",
      change: deriveChangeHealth(""),
    });
    await expect(
      store.saveHealthSample({
        ...sample(runA1, "2026-08-21T00:00:01.000Z", revisionByRun.get(runA1) ?? ""),
        candidateId: candidateByRun.get(runA3) ?? "missing",
      }),
    ).rejects.toThrow(/not bound/iu);
    await expect(
      store.saveHealthSample({
        ...sample(runA1, "2026-08-21T00:00:02.000Z", revisionByRun.get(runA1) ?? ""),
        projectId: projectIdentity("/fixture-b"),
      }),
    ).rejects.toThrow(/project/iu);
    await expect(
      store.saveHealthSample({
        ...sample(runA1, "2026-08-21T00:00:03.000Z", "f".repeat(40)),
      }),
    ).rejects.toThrow(/not bound/iu);
    await store.saveHealthSample(
      sample(runA3, "2026-08-21T00:03:00.000Z", revisionByRun.get(runA3) ?? ""),
    );
    await store.saveHealthSample(
      sample(runA1, "2026-08-21T00:01:00.000Z", revisionByRun.get(runA1) ?? ""),
    );
    await store.saveHealthSample(
      sample(runB, "2026-08-21T00:04:00.000Z", revisionByRun.get(runB) ?? "", "/fixture-b"),
    );
    await store.saveHealthSample(
      sample(runA2, "2026-08-21T00:02:00.000Z", revisionByRun.get(runA2) ?? ""),
    );

    const window = await store.listHealthSamples(projectIdentity("/fixture"), 2);
    expect(window.map((entry) => [entry.projectId, entry.runId, entry.revision])).toEqual([
      [projectIdentity("/fixture"), runA2, revisionByRun.get(runA2)],
      [projectIdentity("/fixture"), runA3, revisionByRun.get(runA3)],
    ]);

    await pool.query(
      `UPDATE health_samples
       SET payload = jsonb_set(payload, '{revision}', $2::jsonb)
       WHERE run_id = $1`,
      [runA3, JSON.stringify("f".repeat(40))],
    );
    await expect(store.listHealthSamples(projectIdentity("/fixture"), 20)).rejects.toThrow(
      /row binding/iu,
    );
  });
});
