import { metrics, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import type { TelemetryRecord, TelemetrySink } from "../domain/ports";
import { redactSecrets } from "./credentials";

export class DomainTelemetryRecorder implements TelemetrySink {
  private readonly records: TelemetryRecord[] = [];
  private readonly tracer = trace.getTracer("adaptive-agent-harness");
  private readonly counter = metrics
    .getMeter("adaptive-agent-harness")
    .createCounter("harness.runs", { description: "Harness run outcomes" });

  async record(record: TelemetryRecord): Promise<void> {
    const sanitized = redactSecrets(record) as unknown as TelemetryRecord;
    this.records.push(structuredClone(sanitized));
    this.counter.add(1, {
      execution_mode: sanitized.executionMode,
      verification_state: sanitized.verificationState,
    });
    this.tracer.startActiveSpan("harness.run.completed", (span) => {
      span.setAttributes({
        "harness.task_id": sanitized.taskId,
        "harness.run_id": sanitized.runId,
        "harness.initial_mode": sanitized.initialMode,
        "harness.final_mode": sanitized.finalMode,
        "harness.execution_mode": sanitized.executionMode,
        "harness.verified_success": sanitized.verifiedSuccess,
        "harness.signal_snapshots": sanitized.signalSnapshots,
        "harness.dependency_expansion": sanitized.dependencyExpansion,
        "harness.touched_modules": sanitized.touchedModules,
        "harness.cross_module_edges": sanitized.crossModuleEdges,
        "harness.verifier_failures": sanitized.verifierFailures,
        "harness.context_expansion": sanitized.contextExpansion,
        "harness.mode_transitions": sanitized.modeTransitions,
        "harness.strict_reexpansions": sanitized.strictReexpansions,
        "harness.verification_attempts": sanitized.verificationAttempts,
        "harness.repair_attempts": sanitized.repairAttempts,
        "harness.module_count_observed": sanitized.moduleCountObserved,
        "harness.stabilization_invalidations": sanitized.stabilizationInvalidations,
        "harness.cost.known": sanitized.modelCost !== null,
      });
      if (sanitized.latestSignalSnapshotId)
        span.setAttribute("harness.signal_snapshot.latest_id", sanitized.latestSignalSnapshotId);
      if (sanitized.modelCost !== null)
        span.setAttribute(
          "harness.cost.total",
          sanitized.modelCost +
            sanitized.sandboxCost +
            sanitized.verificationCost +
            sanitized.retryCost +
            sanitized.recoveryCost,
        );
      span.end();
    });
  }

  async costPerVerifiedSuccess(): Promise<number | null> {
    const knownSuccesses = this.records.filter(
      (record) => record.verifiedSuccess && record.modelCost !== null,
    );
    if (knownSuccesses.length === 0) return null;
    const total = knownSuccesses.reduce(
      (sum, record) =>
        sum +
        (record.modelCost ?? 0) +
        record.sandboxCost +
        record.verificationCost +
        record.retryCost +
        record.recoveryCost,
      0,
    );
    return total / knownSuccesses.length;
  }

  snapshot(): TelemetryRecord[] {
    return this.records.map((record) => structuredClone(record));
  }
}

export class LangfuseHttpExporter {
  constructor(
    private readonly baseUrl: string,
    private readonly authorization: () => Promise<string>,
  ) {}

  async export(record: TelemetryRecord): Promise<void> {
    const auth = await this.authorization();
    const response = await fetch(`${this.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ batch: [{ type: "trace-create", body: redactSecrets(record) }] }),
    });
    if (!response.ok) throw new Error(`Langfuse export failed with ${response.status}`);
  }
}

export class PostgresTelemetrySink implements TelemetrySink {
  constructor(
    private readonly pool: Pool,
    private readonly genericTelemetry: TelemetrySink,
  ) {}

  async record(record: TelemetryRecord): Promise<void> {
    await this.genericTelemetry.record(record);
    const totalCost =
      record.modelCost === null
        ? null
        : record.modelCost +
          record.sandboxCost +
          record.verificationCost +
          record.retryCost +
          record.recoveryCost;
    await this.pool.query(
      `INSERT INTO telemetry(
        task_id, run_id, execution_mode, verification_state, verified_success,
        input_tokens, output_tokens, cached_tokens, total_cost, latency_ms,
        retry_count, payload, timestamp
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        record.taskId,
        record.runId,
        record.executionMode,
        record.verificationState,
        record.verifiedSuccess,
        record.inputTokens,
        record.outputTokens,
        record.cachedTokens,
        totalCost,
        Math.round(record.latencyMs),
        record.retryCount,
        record,
        record.timestamp,
      ],
    );
  }

  async costPerVerifiedSuccess(): Promise<number | null> {
    const result = await this.pool.query<{ value: string | null }>(
      `SELECT AVG(total_cost) FILTER (
         WHERE verified_success AND total_cost IS NOT NULL
       ) AS value
       FROM telemetry`,
    );
    const value = result.rows[0]?.value;
    return value === null || value === undefined ? null : Number(value);
  }
}
