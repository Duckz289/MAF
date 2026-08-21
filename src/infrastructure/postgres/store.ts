import type { Pool } from "pg";
import { assertHealthSample, type HealthSample } from "../../domain/health";
import {
  assertCiEvidence,
  assertDeliveryHandoff,
  deliveryHandoffDigest,
  type CiEvidence,
  type DeliveryHandoff,
} from "../../domain/delivery";
import type { RunStore } from "../../domain/ports";
import { projectIdentity } from "../../domain/project-identity";
import { redactSensitiveData } from "../../domain/security";
import {
  assertStrategyObservation,
  strategyObservationBinding,
  type StrategyObservation,
} from "../../domain/strategy";
import type {
  Artifact,
  Event,
  RecoveryCapsule,
  Run,
  RuntimeSignalSnapshot,
  Task,
  Verification,
} from "../../domain/types";

/**
 * Defensive fallback for payloads written before migration 004 backfilled desiredMode/
 * effectiveMode into the jsonb payload. The migration is the primary fix; this keeps hydration
 * honest (mirroring the known executionMode, never inventing a different value) if it ever runs
 * against a row the migration missed.
 */
const hydrateRunPayload = (payload: Run): Run => ({
  ...payload,
  desiredMode: payload.desiredMode ?? payload.executionMode,
  effectiveMode: payload.effectiveMode ?? payload.executionMode,
});

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
      `INSERT INTO runs(id, task_id, state, execution_mode, desired_mode, effective_mode,
                        verification_state, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        run.id,
        run.taskId,
        run.state,
        run.executionMode,
        run.desiredMode,
        run.effectiveMode,
        run.verificationState,
        run,
        run.createdAt,
        run.updatedAt,
      ],
    );
  }

  async updateRun(run: Run): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET state=$2, execution_mode=$3, desired_mode=$4, effective_mode=$5,
              verification_state=$6, payload=$7, updated_at=$8 WHERE id=$1`,
      [
        run.id,
        run.state,
        run.executionMode,
        run.desiredMode,
        run.effectiveMode,
        run.verificationState,
        run,
        run.updatedAt,
      ],
    );
  }

  async getRun(id: string): Promise<Run | undefined> {
    const result = await this.pool.query<{ payload: Run }>("SELECT payload FROM runs WHERE id=$1", [
      id,
    ]);
    const payload = result.rows[0]?.payload;
    return payload ? hydrateRunPayload(payload) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    const result = await this.pool.query<{ payload: Run }>(
      "SELECT payload FROM runs ORDER BY created_at DESC LIMIT 500",
    );
    return result.rows.map((row) => hydrateRunPayload(row.payload));
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
          enforcement?: { method?: string };
        };
        await client.query(
          `INSERT INTO mode_transitions(
             id, run_id, from_mode, to_mode, reason, evidence, timestamp,
             signal_snapshot_id, evidence_ids, enforcement_method
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
            data.enforcement?.method ?? null,
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

  async saveRecoveryCapsule(capsule: RecoveryCapsule): Promise<void> {
    await this.pool.query(
      `INSERT INTO recovery_capsules(run_id, recovery_reason, payload, created_at, updated_at)
       VALUES($1, $2, $3, $4, $4)
       ON CONFLICT (run_id) DO UPDATE SET
         recovery_reason = EXCLUDED.recovery_reason,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [capsule.runId, capsule.recoveryReason, capsule, capsule.createdAt],
    );
  }

  async getRecoveryCapsule(runId: string): Promise<RecoveryCapsule | undefined> {
    const result = await this.pool.query<{ payload: RecoveryCapsule }>(
      "SELECT payload FROM recovery_capsules WHERE run_id=$1",
      [runId],
    );
    return result.rows[0]?.payload;
  }

  async saveHealthSample(sample: HealthSample): Promise<void> {
    const sanitizedSample: unknown = redactSensitiveData(sample);
    assertHealthSample(sanitizedSample);
    sample = sanitizedSample;
    const binding = await this.pool.query<{ repositoryPath: string }>(
      `SELECT t.repository_path AS "repositoryPath"
       FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE r.id = $1`,
      [sample.runId],
    );
    const repositoryPath = binding.rows[0]?.repositoryPath;
    if (!repositoryPath || projectIdentity(repositoryPath) !== sample.projectId) {
      throw new Error("Health sample project does not match its run task");
    }
    const inserted = await this.pool.query(
      `INSERT INTO health_samples(
         id, project_id, revision, timestamp, run_id, candidate_id, candidate_digest,
         evidence_basis, payload
       )
       SELECT $1, $2, $3, $4, r.id, a.id, $7, $8, $9
       FROM runs r
       JOIN tasks t ON t.id = r.task_id
       JOIN artifacts a ON a.id = $6 AND a.run_id = r.id
       WHERE r.id = $5
         AND r.state = 'COMPLETED'
         AND r.verification_state = 'VERIFIED'
         AND t.repository_path = $10
         AND a.kind = 'DIFF'
         AND a.digest = $7
         AND a.metadata->>'baseRevision' = $3
         AND EXISTS (
           SELECT 1 FROM verifications v
           WHERE v.run_id = r.id AND v.candidate_id = a.id AND v.state = 'VERIFIED'
         )
       RETURNING run_id`,
      [
        crypto.randomUUID(),
        sample.projectId,
        sample.revision,
        sample.timestamp,
        sample.runId,
        sample.candidateId,
        sample.candidateDigest,
        sample.evidenceBasis,
        sample,
        repositoryPath,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new Error(
        "Health sample is not bound to a verified run and matching candidate artifact",
      );
    }
  }

  async listHealthSamples(projectId?: string, limit?: number): Promise<HealthSample[]> {
    const boundedLimit = Math.min(500, Math.max(0, limit ?? 500));
    const result = await this.pool.query<{
      projectId: string;
      revision: string | null;
      runId: string;
      candidateId: string;
      candidateDigest: string;
      evidenceBasis: string;
      timestamp: string;
      payload: unknown;
    }>(
      `SELECT project_id AS "projectId", revision, run_id::text AS "runId",
              candidate_id::text AS "candidateId", candidate_digest AS "candidateDigest",
              evidence_basis AS "evidenceBasis", timestamp::text, payload
       FROM (
         SELECT id, project_id, revision, run_id, candidate_id, candidate_digest,
                evidence_basis, timestamp, payload
         FROM health_samples
         WHERE ($1::text IS NULL OR project_id = $1)
         ORDER BY timestamp DESC, run_id DESC
         LIMIT $2
       ) recent
       ORDER BY timestamp ASC, run_id ASC`,
      [projectId ?? null, boundedLimit],
    );
    return result.rows.map((row) => {
      assertHealthSample(row.payload);
      if (
        row.payload.projectId !== row.projectId ||
        row.payload.runId !== row.runId ||
        row.payload.candidateId !== row.candidateId ||
        row.payload.candidateDigest !== row.candidateDigest ||
        row.payload.evidenceBasis !== row.evidenceBasis ||
        row.payload.revision !== row.revision ||
        Date.parse(row.payload.timestamp) !== Date.parse(row.timestamp)
      ) {
        throw new Error("Health sample payload identity does not match its durable row binding");
      }
      return row.payload;
    });
  }

  async saveStrategyObservation(observation: StrategyObservation): Promise<void> {
    const sanitized: unknown = redactSensitiveData(observation);
    assertStrategyObservation(sanitized);
    observation = sanitized;
    const binding = await this.pool.query<{ repositoryPath: string }>(
      `SELECT t.repository_path AS "repositoryPath"
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = $1`,
      [observation.runId],
    );
    const repositoryPath = binding.rows[0]?.repositoryPath;
    if (!repositoryPath || projectIdentity(repositoryPath) !== observation.scope.projectId)
      throw new Error("Strategy observation project does not match its run task");
    const inserted = await this.pool.query(
      `INSERT INTO strategy_observations(
         id, observation_id, project_id, timestamp, run_id, candidate_id, candidate_digest,
         evidence_basis, payload
       )
       SELECT $1, $2, $3, $4, r.id, a.id, $7, $8, $9
      FROM runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN artifacts a ON a.id = $6 AND a.run_id = r.id
      WHERE r.id = $5
         AND r.state IN ('COMPLETED', 'FAILED')
         AND CAST($19 AS boolean) = (r.verification_state = 'VERIFIED')
         AND (($8 = 'RUN_STORE_VERIFIED' AND CAST($19 AS boolean))
           OR ($8 = 'RUN_STORE_TERMINAL' AND NOT CAST($19 AS boolean)))
         AND r.payload->>'trustState' = $10
         AND t.repository_path = $11
         AND a.kind = 'DIFF'
         AND a.digest = $7
         AND r.payload->>'agent' = $12
         AND r.payload->>'model' = $13
         AND r.payload->>'provider' = $14
         AND r.payload->>'effectiveMode' = $15
         AND COALESCE(t.payload->>'qualityPreference', 'BALANCED') = $16
         AND $17 = CASE
           WHEN t.payload->'verification'->>'command' IS NOT NULL THEN 'COMMAND'
           WHEN t.payload->'verification'->>'expectedFile' IS NOT NULL THEN 'EXPECTED_FILE'
           ELSE 'DEFAULT'
         END
         AND $18 = 'CHALLENGER'
         AND r.payload->'strategyEvidenceBinding'->>'projectId' = $3
         AND r.payload->'strategyEvidenceBinding'->>'taskClass' = $20
         AND r.payload->'strategyEvidenceBinding'->>'riskProfile' = $21
         AND r.payload->'strategyEvidenceBinding'->>'qualityRequirement' = $22
         AND r.payload->'strategyEvidenceBinding'->>'reviewPolicy' = $23
         AND r.payload->'strategyObservationBinding' = $24::jsonb
         AND (r.payload->>'completedAt')::timestamptz = $4
         AND (r.payload->>'retryCount')::integer = $25
         AND ($26::numeric IS NULL OR (r.payload->'cost'->>'total')::numeric = $26::numeric)
         AND EXISTS (
           SELECT 1 FROM verifications v
           WHERE v.run_id = r.id AND v.candidate_id = a.id
             AND v.state = r.verification_state
         )
       RETURNING run_id`,
      [
        crypto.randomUUID(),
        observation.id,
        observation.scope.projectId,
        observation.timestamp,
        observation.runId,
        observation.candidateId,
        observation.candidateDigest,
        observation.evidenceBasis,
        observation,
        observation.trustState,
        repositoryPath,
        observation.strategy.adapter,
        observation.strategy.model,
        observation.strategy.provider,
        observation.strategy.executionMode,
        observation.strategy.qualityPreference,
        observation.strategy.verificationProfile,
        observation.strategy.baseline,
        observation.verifiedSuccess,
        observation.scope.taskClass,
        observation.scope.riskProfile,
        observation.scope.qualityRequirement,
        observation.strategy.reviewPolicy,
        strategyObservationBinding(observation),
        observation.retries,
        observation.costUsd,
      ],
    );
    if (inserted.rowCount !== 1)
      throw new Error("Strategy observation is not bound to its verified run and candidate");
  }

  async listStrategyObservations(
    projectId?: string,
    limit?: number,
  ): Promise<StrategyObservation[]> {
    const bounded = Math.min(500, Math.max(0, limit ?? 500));
    const result = await this.pool.query<{
      observationId: string;
      projectId: string;
      runId: string;
      candidateId: string;
      candidateDigest: string;
      evidenceBasis: string;
      timestamp: string;
      payload: unknown;
    }>(
      `SELECT observation_id AS "observationId", project_id AS "projectId",
              run_id::text AS "runId", candidate_id::text AS "candidateId",
              candidate_digest AS "candidateDigest", evidence_basis AS "evidenceBasis",
              timestamp::text, payload
       FROM (
         SELECT observation_id, project_id, run_id, candidate_id, candidate_digest,
                evidence_basis, timestamp, payload
         FROM strategy_observations
         WHERE ($1::text IS NULL OR project_id = $1)
         ORDER BY timestamp DESC, run_id DESC LIMIT $2
       ) recent ORDER BY timestamp ASC, run_id ASC`,
      [projectId ?? null, bounded],
    );
    return result.rows.map((row) => {
      assertStrategyObservation(row.payload);
      if (
        row.payload.id !== row.observationId ||
        row.payload.scope.projectId !== row.projectId ||
        row.payload.runId !== row.runId ||
        row.payload.candidateId !== row.candidateId ||
        row.payload.candidateDigest !== row.candidateDigest ||
        row.payload.evidenceBasis !== row.evidenceBasis ||
        Date.parse(row.payload.timestamp) !== Date.parse(row.timestamp)
      )
        throw new Error(
          "Strategy observation payload identity does not match its durable row binding",
        );
      return row.payload;
    });
  }

  async allocateStrategyCanaryOrdinal(allocationKey: string): Promise<number> {
    if (!/^strategy-[a-f0-9]{64}$/u.test(allocationKey))
      throw new Error("Malformed strategy allocation key");
    const result = await this.pool.query<{ ordinal: string }>(
      `INSERT INTO strategy_canary_counters(allocation_key, next_ordinal)
       VALUES ($1, 1)
       ON CONFLICT (allocation_key) DO UPDATE
         SET next_ordinal = strategy_canary_counters.next_ordinal + 1
       RETURNING (next_ordinal - 1)::text AS ordinal`,
      [allocationKey],
    );
    const ordinal = Number(result.rows[0]?.ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0)
      throw new Error("Strategy canary allocator returned an invalid ordinal");
    return ordinal;
  }

  async saveDeliveryHandoff(handoff: DeliveryHandoff): Promise<void> {
    const sanitized: unknown = redactSensitiveData(handoff);
    assertDeliveryHandoff(sanitized);
    handoff = sanitized;
    const binding = await this.pool.query<{ repositoryPath: string }>(
      `SELECT t.repository_path AS "repositoryPath"
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = $1`,
      [handoff.runId],
    );
    const repositoryPath = binding.rows[0]?.repositoryPath;
    if (!repositoryPath || projectIdentity(repositoryPath) !== handoff.projectId)
      throw new Error("Delivery handoff project does not match its run task");
    const inserted = await this.pool.query(
      `INSERT INTO delivery_handoffs(
         id, project_id, run_id, candidate_id, candidate_digest, base_revision, payload, created_at
       )
       SELECT $1, $2, r.id, a.id, $5, $6, $7, $8
       FROM runs r
       JOIN tasks t ON t.id = r.task_id
       JOIN artifacts a ON a.id = $4 AND a.run_id = r.id
       WHERE r.id = $3
         AND r.state = 'COMPLETED'
         AND r.verification_state = 'VERIFIED'
         AND t.repository_path = $9
         AND a.kind = 'DIFF'
         AND a.digest = $5
         AND a.metadata->>'baseRevision' = $6
         AND r.payload->>'trustState' = $10
         AND (r.payload->>'completedAt')::timestamptz = $8
         AND r.payload->'deliveryHandoffBinding'->>'handoffId' = ($1::uuid)::text
         AND r.payload->'deliveryHandoffBinding'->>'candidateId' = ($4::uuid)::text
         AND r.payload->'deliveryHandoffBinding'->>'candidateDigest' = $5
         AND r.payload->'deliveryHandoffBinding'->>'payloadDigest' = $11
         AND EXISTS (
           SELECT 1 FROM verifications v
           WHERE v.id = $12 AND v.run_id = r.id AND v.candidate_id = a.id AND v.state = 'VERIFIED'
         )
       RETURNING run_id`,
      [
        handoff.id,
        handoff.projectId,
        handoff.runId,
        handoff.candidateId,
        handoff.candidateDigest,
        handoff.baseRevision,
        handoff,
        handoff.createdAt,
        repositoryPath,
        handoff.trustState,
        deliveryHandoffDigest(handoff),
        handoff.verification.id,
      ],
    );
    if (inserted.rowCount !== 1)
      throw new Error("Delivery handoff is not bound to its terminal verified candidate");
  }

  async getDeliveryHandoff(runId: string): Promise<DeliveryHandoff | undefined> {
    const result = await this.pool.query<{
      id: string;
      projectId: string;
      runId: string;
      candidateId: string;
      candidateDigest: string;
      baseRevision: string;
      createdAt: string;
      payload: unknown;
    }>(
      `SELECT id::text, project_id AS "projectId", run_id::text AS "runId",
              candidate_id::text AS "candidateId", candidate_digest AS "candidateDigest",
              base_revision AS "baseRevision", created_at::text AS "createdAt", payload
       FROM delivery_handoffs WHERE run_id=$1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const payload = row?.payload;
    if (payload === undefined || payload === null) return undefined;
    assertDeliveryHandoff(payload);
    if (
      payload.id !== row.id ||
      payload.projectId !== row.projectId ||
      payload.runId !== row.runId ||
      payload.candidateId !== row.candidateId ||
      payload.candidateDigest !== row.candidateDigest ||
      payload.baseRevision !== row.baseRevision ||
      Date.parse(payload.createdAt) !== Date.parse(row.createdAt)
    ) {
      throw new Error("Delivery handoff payload identity does not match its durable row binding");
    }
    return payload;
  }

  async saveCiEvidence(evidence: CiEvidence): Promise<void> {
    const sanitized: unknown = redactSensitiveData(evidence);
    assertCiEvidence(sanitized);
    evidence = sanitized;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `WITH handoff_head AS (
         UPDATE delivery_handoffs h
         SET ci_head_revision = COALESCE(ci_head_revision, $12)
         WHERE h.id = $2
           AND h.candidate_id = $8
           AND h.candidate_digest = $9
           AND h.base_revision = $10
           AND (h.payload->'headRevision' = 'null'::jsonb
             OR h.payload->'headRevision' = $11::jsonb)
           AND (ci_head_revision IS NULL OR $12::text IS NULL OR ci_head_revision = $12)
         RETURNING h.id
       ), external_binding AS (
         INSERT INTO ci_run_bindings(provider, external_run_id, handoff_id, head_revision)
         SELECT $3, $4, id, $12 FROM handoff_head
         ON CONFLICT (provider, external_run_id) DO UPDATE
           SET head_revision = COALESCE(ci_run_bindings.head_revision, EXCLUDED.head_revision)
           WHERE ci_run_bindings.handoff_id = EXCLUDED.handoff_id
             AND (ci_run_bindings.head_revision IS NULL
               OR EXCLUDED.head_revision IS NULL
               OR ci_run_bindings.head_revision = EXCLUDED.head_revision)
         RETURNING handoff_id
       )
       INSERT INTO ci_evidence(
         id, handoff_id, provider, external_run_id, conclusion, observed_at, payload
       )
       SELECT $1, h.id, $3, $4, $5, $6, $7
       FROM delivery_handoffs h
       JOIN handoff_head hh ON hh.id = h.id
       JOIN external_binding b ON b.handoff_id = h.id
       WHERE h.id = $2
         AND h.candidate_id = $8
         AND h.candidate_digest = $9
         AND h.base_revision = $10
         AND (h.payload->'headRevision' = 'null'::jsonb
           OR h.payload->'headRevision' = $11::jsonb)
       RETURNING id`,
        [
          evidence.id,
          evidence.handoffId,
          evidence.provider,
          evidence.externalRunId,
          evidence.conclusion,
          evidence.observedAt,
          evidence,
          evidence.candidateId,
          evidence.candidateDigest,
          evidence.baseRevision,
          JSON.stringify(evidence.headRevision),
          evidence.headRevision,
        ],
      );
      if (inserted.rowCount !== 1)
        throw new Error("CI evidence is stale or not bound to its delivery handoff");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCiEvidence(handoffId: string): Promise<CiEvidence[]> {
    const result = await this.pool.query<{
      id: string;
      handoffId: string;
      provider: string;
      externalRunId: string;
      conclusion: string;
      observedAt: string;
      payload: unknown;
    }>(
      `SELECT id::text, handoff_id::text AS "handoffId", provider,
              external_run_id AS "externalRunId", conclusion,
              observed_at::text AS "observedAt", payload
       FROM ci_evidence WHERE handoff_id=$1 ORDER BY observed_at, id`,
      [handoffId],
    );
    return result.rows.map((row) => {
      assertCiEvidence(row.payload);
      if (
        row.payload.id !== row.id ||
        row.payload.handoffId !== row.handoffId ||
        row.payload.provider !== row.provider ||
        row.payload.externalRunId !== row.externalRunId ||
        row.payload.conclusion !== row.conclusion ||
        Date.parse(row.payload.observedAt) !== Date.parse(row.observedAt)
      ) {
        throw new Error("CI evidence payload identity does not match its durable row binding");
      }
      return row.payload;
    });
  }
}
