import { describe, expect, it } from "vitest";
import type { TelemetryRecord } from "../src/domain/ports";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";

const record = (modelCost: number | null, verifiedSuccess = true): TelemetryRecord => ({
  taskId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  agent: "fixture",
  model: "fixture",
  provider: "fixture",
  initialMode: "GUIDED",
  finalMode: "GUIDED",
  finalDesiredMode: "GUIDED",
  executionMode: "GUIDED",
  policyLiveUpdates: 0,
  policyBoundaryEnforcements: 0,
  policySafeRestarts: 0,
  pendingPolicyAtCompletion: false,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  modelCost,
  sandboxCost: 0,
  verificationCost: 0,
  retryCost: 0,
  recoveryCost: 0,
  latencyMs: 1,
  retryCount: 0,
  filesChanged: 1,
  verificationType: "command",
  verificationState: verifiedSuccess ? "VERIFIED" : "QUARANTINED",
  modeTransitions: 0,
  strictReexpansions: 0,
  signalSnapshots: 1,
  latestSignalSnapshotId: crypto.randomUUID(),
  dependencyExpansion: 0,
  touchedModules: 1,
  crossModuleEdges: 0,
  verifierFailures: verifiedSuccess ? 0 : 1,
  verificationAttempts: 1,
  repairAttempts: 0,
  moduleCountObserved: 1,
  stabilizationInvalidations: 0,
  contextExpansion: 0,
  verifiedSuccess,
  budgetMode: "ADVISORY",
  budgetLimitUsd: null,
  budgetExhausted: false,
  timestamp: new Date().toISOString(),
});

describe("DomainTelemetryRecorder", () => {
  it("excludes unknown model cost from cost per verified success", async () => {
    const telemetry = new DomainTelemetryRecorder();
    await telemetry.record(record(null));
    expect(await telemetry.costPerVerifiedSuccess()).toBeNull();
    await telemetry.record(record(0.4));
    expect(await telemetry.costPerVerifiedSuccess()).toBe(0.4);
    expect(telemetry.snapshot()[0]?.modelCost).toBeNull();
  });
});
