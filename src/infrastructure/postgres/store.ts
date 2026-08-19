import type { Pool } from "pg";
import type { RunStore } from "../../domain/ports";
import type {
  Artifact,
  Event,
  Run,
  RuntimeSignalSnapshot,
  Task,
  Verification,
} from "../../domain/types";

export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async createTask(task: Task): Promise<void> {
    await this.pool.query(
      `INSERT INTO tasks(id, repository_path, revision, prompt, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task.id, task.repositoryPath, task.revision, task.prompt, task, task.createdAt],
    );
  }

  async getTask(id: string): Promise<Task | undefined> {
    const result = await this.pool.query<{ payload: Task }>(
      "SELECT payload FROM tasks WHERE id=$1",
      [id],
    );
    return result.rows[0]?.payload;
  }

  async createRun(run: Run): Promise<void> {
    await this.pool.query(
      `INSERT INTO runs(id, task_id, state, execution_mode, verification_state, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        run.taskId,
        run.state,
        run.executionMode,
        run.verificationState,
        run,
        run.createdAt,
        run.updatedAt,
      ],
    );
  }

  async updateRun(run: Run): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET state=$2, execution_mode=$3, verification_state=$4, payload=$5, updated_at=$6 WHERE id=$1`,
      [run.id, run.state, run.executionMode, run.verificationState, run, run.updatedAt],
    );
  }

  async getRun(id: string): Promise<Run | undefined> {
    const result = await this.pool.query<{ payload: Run }>("SELECT payload FROM runs WHERE id=$1", [
      id,
    ]);
    return result.rows[0]?.payload;
  }

  async listRuns(): Promise<Run[]> {
    const result = await this.pool.query<{ payload: Run }>(
      "SELECT payload FROM runs ORDER BY created_at DESC LIMIT 500",
    );
    return result.rows.map((row) => row.payload);
  }

  async appendEvent(event: Event<unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO events(id, run_id, type, timestamp, data) VALUES($1, $2, $3, $4, $5)",
        [event.id, event.runId, event.type, event.timestamp, event.data],
      );
      if (event.type === "ModeChanged") {
        const data = event.data as {
          from: string;
          to: string;
          reason: string;
          evidence: unknown;
          signalSnapshotId?: string;
          evidenceIds?: string[];
        };
        await client.query(
          `INSERT INTO mode_transitions(
             id, run_id, from_mode, to_mode, reason, evidence, timestamp,
             signal_snapshot_id, evidence_ids
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            event.runId,
            data.from,
            data.to,
            data.reason,
            data.evidence,
            event.timestamp,
            data.signalSnapshotId ?? null,
            JSON.stringify(data.evidenceIds ?? []),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(runId: string, after?: string): Promise<Event<unknown>[]> {
    if (!after) {
      const result = await this.pool.query<Event<unknown>>(
        `SELECT id, run_id AS "runId", type, timestamp::text, data
         FROM events WHERE run_id=$1 ORDER BY sequence`,
        [runId],
      );
      return result.rows;
    }
    const result = await this.pool.query<Event<unknown>>(
      `SELECT id, run_id AS "runId", type, timestamp::text, data FROM events
       WHERE run_id=$1 AND sequence > COALESCE((SELECT sequence FROM events WHERE id=$2), 0)
       ORDER BY sequence`,
      [runId, after],
    );
    return result.rows;
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts(id, run_id, kind, uri, digest, metadata, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)`,
      [
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.uri,
        artifact.digest,
        artifact.metadata,
        artifact.createdAt,
      ],
    );
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    const result = await this.pool.query<Artifact>(
      `SELECT id, run_id AS "runId", kind, uri, digest, metadata, created_at::text AS "createdAt"
       FROM artifacts WHERE run_id=$1 ORDER BY created_at`,
      [runId],
    );
    return result.rows;
  }

  async addVerification(verification: Verification): Promise<void> {
    await this.pool.query(
      `INSERT INTO verifications(
         id, run_id, type, state, command, exit_code, output, started_at, completed_at,
         attempt, candidate_id
       ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        verification.id,
        verification.runId,
        verification.type,
        verification.state,
        verification.command,
        verification.exitCode,
        verification.output,
        verification.startedAt,
        verification.completedAt,
        verification.attempt ?? 1,
        verification.candidateId ?? null,
      ],
    );
  }

  async listVerifications(runId: string): Promise<Verification[]> {
    const result = await this.pool.query<Verification>(
      `SELECT id, run_id AS "runId", type, state, command, exit_code AS "exitCode", output,
              started_at::text AS "startedAt", completed_at::text AS "completedAt",
              attempt, candidate_id AS "candidateId"
       FROM verifications WHERE run_id=$1 ORDER BY attempt, started_at`,
      [runId],
    );
    return result.rows;
  }

  async addSignalSnapshot(snapshot: RuntimeSignalSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_signal_snapshots(id, run_id, sequence, checkpoint, signals, evidence, timestamp)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        snapshot.id,
        snapshot.runId,
        snapshot.sequence,
        snapshot.checkpoint,
        snapshot.signals,
        JSON.stringify(snapshot.evidence),
        snapshot.timestamp,
      ],
    );
  }

  async listSignalSnapshots(runId: string): Promise<RuntimeSignalSnapshot[]> {
    const result = await this.pool.query<RuntimeSignalSnapshot>(
      `SELECT id, run_id AS "runId", sequence, checkpoint, signals, evidence,
              timestamp::text AS timestamp
       FROM runtime_signal_snapshots WHERE run_id=$1 ORDER BY sequence`,
      [runId],
    );
    return result.rows;
  }
}
