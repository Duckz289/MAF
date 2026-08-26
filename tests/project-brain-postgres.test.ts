import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeRecord } from "../src/domain/ports";
import { PostgresProjectBrain } from "../src/infrastructure/project-brain";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Session 5 PostgreSQL ProjectBrain durability", () => {
  const schema = `maf_project_brain_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let firstPool: Pool;
  let reloadedPool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    firstPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of (await readdir(path.resolve("migrations"))).toSorted()) {
      if (migration.endsWith(".sql")) {
        await firstPool.query(await readFile(path.resolve("migrations", migration), "utf8"));
      }
    }
  }, 60_000);

  afterAll(async () => {
    await reloadedPool?.end();
    await firstPool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("survives adapter/pool reload and keeps duplicate writes idempotent", async () => {
    const record: KnowledgeRecord = {
      id: "durable-fact",
      projectId: "/durable/project",
      revision: "a".repeat(40),
      kind: "FACT",
      statement: "The deterministic repository index observed src/domain/order.ts.",
      evidenceIds: ["durable-evidence"],
      status: "ACTIVE",
      createdAt: "2026-08-24T00:00:00.000Z",
      provenance: {
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
        sourceId: "src/domain/order.ts",
        sourceDigest: "b".repeat(64),
        runId: "run-1",
      },
    };
    const first = new PostgresProjectBrain(firstPool);
    expect(await first.add(record)).toBe("INSERTED");

    reloadedPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const reloaded = new PostgresProjectBrain(reloadedPool);
    expect(await reloaded.list(record.projectId, record.revision, ["FACT"], 10)).toEqual([record]);
    expect(await reloaded.add({ ...record, createdAt: "2026-08-24T01:00:00.000Z" })).toBe(
      "UNCHANGED",
    );
    expect(await reloaded.list(record.projectId, record.revision, ["FACT"], 10)).toHaveLength(1);

    expect(await reloaded.markStale(record.projectId, "c".repeat(40))).toBe(1);
    expect(await reloaded.list(record.projectId, record.revision, ["FACT"], 10)).toEqual([]);
    expect(await reloaded.add(record)).toBe("REACTIVATED");
    expect(await reloaded.list(record.projectId, record.revision, ["FACT"], 10)).toEqual([record]);
  });

  it("commits all batch records or rolls back a mid-batch database failure", async () => {
    const brain = new PostgresProjectBrain(firstPool);
    const record = (id: string, sourceId: string): KnowledgeRecord => ({
      id,
      projectId: "/durable/atomic-project",
      revision: "d".repeat(40),
      kind: "EVIDENCE",
      statement: `Atomic batch evidence ${id}`,
      evidenceIds: [],
      status: "ACTIVE",
      createdAt: "2026-08-24T00:00:00.000Z",
      provenance: {
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
        sourceId,
        sourceDigest: id === "atomic-a" ? "1".repeat(64) : "2".repeat(64),
      },
    });
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION reject_session6_mid_batch() RETURNS trigger AS $$
      BEGIN
        IF NEW.source_id = 'fail-mid-batch' THEN
          RAISE EXCEPTION 'session6 injected mid-batch failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_session6_mid_batch_trigger
      BEFORE INSERT ON project_knowledge
      FOR EACH ROW EXECUTE FUNCTION reject_session6_mid_batch();
    `);

    await expect(
      brain.addBatch([record("atomic-a", "src/a.ts"), record("atomic-b", "fail-mid-batch")]),
    ).rejects.toThrow("session6 injected mid-batch failure");
    expect(
      await firstPool.query(
        `SELECT id FROM project_knowledge WHERE project_id='/durable/atomic-project'`,
      ),
    ).toMatchObject({ rowCount: 0 });

    const retry = await brain.addBatch([
      record("atomic-a", "src/a.ts"),
      record("atomic-b", "src/b.ts"),
    ]);
    expect(retry).toMatchObject({ inserted: 2, unchanged: 0 });
    expect(
      await brain.addBatch([record("atomic-a", "src/a.ts"), record("atomic-b", "src/b.ts")]),
    ).toMatchObject({ inserted: 0, unchanged: 2 });
  });

  it("resolves source-bound knowledge across an unrelated revision and stales changed sources", async () => {
    const brain = new PostgresProjectBrain(firstPool);
    const record: KnowledgeRecord = {
      id: "precise-source-evidence",
      projectId: "/durable/precise-project",
      revision: "e".repeat(40),
      kind: "EVIDENCE",
      statement: "Digest-bound source evidence",
      evidenceIds: [],
      status: "ACTIVE",
      createdAt: "2026-08-24T00:00:00.000Z",
      provenance: {
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
        sourceId: "src/a.ts",
        sourceDigest: "3".repeat(64),
      },
      stalenessInputs: [{ type: "SOURCE_DIGEST", uri: "src/a.ts", digest: "3".repeat(64) }],
      scope: { kind: "FILE", identity: "src/a.ts" },
    };
    await brain.add(record);
    const unchangedBasis = {
      projectId: record.projectId,
      revision: "f".repeat(40),
      sourceDigests: { "src/a.ts": "3".repeat(64) },
      moduleMembershipDigests: {},
    };
    expect(await brain.reconcileStaleness(unchangedBasis)).toMatchObject({
      current: 1,
      stale: 0,
    });
    expect((await brain.resolveCurrent({ ...unchangedBasis, limit: 10 })).current).toHaveLength(1);

    expect(
      await brain.reconcileStaleness({
        ...unchangedBasis,
        sourceDigests: { "src/a.ts": "4".repeat(64) },
      }),
    ).toMatchObject({ current: 0, stale: 1 });
  });
});
