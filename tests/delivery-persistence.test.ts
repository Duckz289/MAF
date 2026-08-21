import { describe, expect, it } from "vitest";
import {
  buildDeliveryHandoff,
  deliveryHandoffDigest,
  type CiEvidence,
} from "../src/domain/delivery";
import { projectIdentity } from "../src/domain/project-identity";
import type { QualityReport } from "../src/domain/quality";
import type { RiskVector } from "../src/domain/risk";
import type { Artifact, Run, Task, Verification } from "../src/domain/types";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";

const quality = Object.fromEntries(
  [
    "Correctness",
    "Architecture",
    "Maintainability",
    "Security",
    "Performance",
    "Resilience",
    "TestQuality",
    "DebtDelta",
  ].map((dimension) => [dimension, { state: "PASS", evidence: [], provenance: "DETERMINISTIC" }]),
) as unknown as QualityReport;
const risk = Object.fromEntries(
  [
    "ReasoningDifficulty",
    "CodeCoupling",
    "BlastRadius",
    "ArchitectureSensitivity",
    "DebtRisk",
    "SecuritySensitivity",
    "PerformanceSensitivity",
    "OperationalSensitivity",
    "NetworkBoundaryChanges",
    "DataConsistencyRisk",
  ].map((dimension) => [dimension, { level: "LOW", provenance: "DETERMINISTIC", evidence: [] }]),
) as unknown as RiskVector;

const setup = async () => {
  const store = new InMemoryRunStore();
  const task: Task = {
    id: "00000000-0000-4000-8000-000000000012",
    prompt: "change",
    repositoryPath: "C:/delivery-repo",
    revision: "a".repeat(40),
    createdAt: "2026-08-21T00:00:00.000Z",
    verification: { command: "test" },
  };
  const run: Run = {
    id: "00000000-0000-4000-8000-000000000011",
    taskId: task.id,
    state: "COMPLETED",
    executionMode: "STRICT",
    desiredMode: "STRICT",
    effectiveMode: "STRICT",
    verificationState: "VERIFIED",
    trustState: "MERGE_ELIGIBLE",
    agent: "agent",
    model: "model",
    provider: "provider",
    createdAt: task.createdAt,
    updatedAt: "2026-08-21T00:01:00.000Z",
    completedAt: "2026-08-21T00:01:00.000Z",
    changedFiles: ["src/index.ts"],
    cost: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
    usage: { input: 0, output: 0, cached: 0 },
    retryCount: 0,
  };
  const candidate: Artifact = {
    id: "00000000-0000-4000-8000-000000000013",
    runId: run.id,
    kind: "DIFF",
    uri: "sandbox://candidate",
    digest: "b".repeat(64),
    metadata: { baseRevision: task.revision },
    createdAt: task.createdAt,
  };
  const verification: Verification = {
    id: "00000000-0000-4000-8000-000000000014",
    runId: run.id,
    type: "command",
    state: "VERIFIED",
    output: "ok",
    startedAt: task.createdAt,
    completedAt: run.completedAt ?? run.updatedAt,
    candidateId: candidate.id,
  };
  const handoff = buildDeliveryHandoff({
    id: "00000000-0000-4000-8000-000000000015",
    projectId: projectIdentity(task.repositoryPath),
    run,
    task,
    candidate,
    verification,
    qualityReport: quality,
    riskVector: risk,
  });
  run.deliveryHandoffBinding = {
    handoffId: handoff.id,
    candidateId: candidate.id,
    candidateDigest: candidate.digest ?? "",
    payloadDigest: deliveryHandoffDigest(handoff),
  };
  await store.createTask(task);
  await store.createRun(run);
  await store.addArtifact(candidate);
  await store.addVerification(verification);
  return { store, handoff };
};

describe("M13 delivery persistence binding", () => {
  it("round-trips exact handoff and rejects a candidate repaint", async () => {
    const { store, handoff } = await setup();
    await store.saveDeliveryHandoff(handoff);
    expect(await store.getDeliveryHandoff(handoff.runId)).toEqual(handoff);
    const other = await setup();
    await expect(
      other.store.saveDeliveryHandoff({ ...other.handoff, candidateDigest: "c".repeat(64) }),
    ).rejects.toThrow(/terminal verified candidate/u);
  });

  it("rejects stale CI evidence while preserving candidate-bound PASS", async () => {
    const { store, handoff } = await setup();
    await store.saveDeliveryHandoff(handoff);
    const evidence: CiEvidence = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000016",
      handoffId: handoff.id,
      provider: "github",
      externalRunId: "42",
      observedAt: "2026-08-21T00:02:00.000Z",
      conclusion: "PENDING",
      candidateId: handoff.candidateId,
      candidateDigest: handoff.candidateDigest,
      baseRevision: handoff.baseRevision,
      headRevision: null,
      checks: [{ name: "test", conclusion: "PENDING" }],
      evidenceRef: "github-actions:42",
    };
    await store.saveCiEvidence(evidence);
    const passed: CiEvidence = {
      ...evidence,
      id: "00000000-0000-4000-8000-000000000017",
      observedAt: "2026-08-21T00:03:00.000Z",
      conclusion: "PASS",
      headRevision: "c".repeat(40),
      checks: [{ name: "test", conclusion: "PASS" }],
    };
    await store.saveCiEvidence(passed);
    expect(await store.listCiEvidence(handoff.id)).toEqual([evidence, passed]);
    await expect(
      store.saveCiEvidence({
        ...passed,
        id: "00000000-0000-4000-8000-000000000018",
        observedAt: "2026-08-21T00:04:00.000Z",
        headRevision: "d".repeat(40),
      }),
    ).rejects.toThrow(/head revision/u);
    await expect(
      store.saveCiEvidence({
        ...passed,
        id: "00000000-0000-4000-8000-000000000019",
        externalRunId: "different-run",
        observedAt: "2026-08-21T00:05:00.000Z",
        headRevision: "d".repeat(40),
      }),
    ).rejects.toThrow(/delivery handoff/u);
    await expect(
      store.saveCiEvidence({ ...evidence, id: "new", externalRunId: "43", candidateId: "stale" }),
    ).rejects.toThrow(/stale/u);
  });
});
