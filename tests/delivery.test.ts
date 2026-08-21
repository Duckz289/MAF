import { describe, expect, it } from "vitest";
import {
  buildDeliveryHandoff,
  deriveDeliveryDecision,
  type CiEvidence,
} from "../src/domain/delivery";
import type { QualityReport } from "../src/domain/quality";
import type { RiskVector } from "../src/domain/risk";
import type { Artifact, Run, Task, Verification } from "../src/domain/types";

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
  ].map((dimension) => [
    dimension,
    {
      state: dimension === "Performance" ? "NOT_REQUIRED" : "PASS",
      evidence: [],
      provenance: "DETERMINISTIC",
    },
  ]),
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

const fixture = () => {
  const run: Run = {
    id: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    state: "COMPLETED",
    executionMode: "STRICT",
    desiredMode: "STRICT",
    effectiveMode: "STRICT",
    verificationState: "VERIFIED",
    trustState: "MERGE_ELIGIBLE",
    agent: "agent",
    model: "model",
    provider: "provider",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
    completedAt: "2026-08-21T00:01:00.000Z",
    changedFiles: ["src/index.ts"],
    cost: { model: 1, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 1 },
    usage: { input: 1, output: 1, cached: 0 },
    retryCount: 0,
  };
  const task: Task = {
    id: run.taskId,
    prompt: "change",
    repositoryPath: "C:/repo",
    revision: "a".repeat(40),
    createdAt: run.createdAt,
    verification: { command: "npm test" },
  };
  const candidate: Artifact = {
    id: "00000000-0000-4000-8000-000000000003",
    runId: run.id,
    kind: "DIFF",
    uri: "sandbox://candidate",
    digest: "b".repeat(64),
    metadata: { baseRevision: "a".repeat(40) },
    createdAt: run.createdAt,
  };
  const verification: Verification = {
    id: "00000000-0000-4000-8000-000000000004",
    runId: run.id,
    type: "command",
    state: "VERIFIED",
    output: "ok",
    startedAt: run.createdAt,
    completedAt: run.completedAt ?? run.updatedAt,
    candidateId: candidate.id,
  };
  const handoff = buildDeliveryHandoff({
    id: "00000000-0000-4000-8000-000000000005",
    projectId: "project-1",
    run,
    task,
    candidate,
    verification,
    qualityReport: quality,
    riskVector: risk,
  });
  return { run, task, candidate, verification, handoff };
};

const ci = (conclusion: CiEvidence["conclusion"]): CiEvidence => {
  const { handoff } = fixture();
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000006",
    handoffId: handoff.id,
    provider: "github",
    externalRunId: "run-42",
    observedAt: "2026-08-21T00:02:00.000Z",
    conclusion,
    candidateId: handoff.candidateId,
    candidateDigest: handoff.candidateDigest,
    baseRevision: handoff.baseRevision,
    headRevision: conclusion === "PASS" ? "c".repeat(40) : null,
    checks: [{ name: "test", conclusion }],
    evidenceRef: "github-actions:run-42",
  };
};

describe("M13 delivery trust model", () => {
  it("keeps missing CI pending and merge authority external", () => {
    const decision = deriveDeliveryDecision(fixture().handoff, []);
    expect(decision.ciStatus).toBe("NOT_CHECKED");
    expect(decision.mergeEligibility).toBe("PENDING");
    expect(decision.mergeAuthority).toBe("EXTERNAL_APPROVAL_REQUIRED");
    expect(decision.autoMergeAllowed).toBe(false);
  });

  it("blocks CI failure and only marks passing external evidence eligible", () => {
    const handoff = fixture().handoff;
    expect(deriveDeliveryDecision(handoff, [ci("FAIL")]).mergeEligibility).toBe("BLOCKED");
    expect(deriveDeliveryDecision(handoff, [ci("PASS")]).mergeEligibility).toBe("ELIGIBLE");
  });

  it("rejects unbound or internally contradictory CI PASS evidence", () => {
    const handoff = fixture().handoff;
    expect(() =>
      deriveDeliveryDecision(handoff, [{ ...ci("PASS"), candidateId: "other" }]),
    ).toThrow(/not bound/u);
    expect(() =>
      deriveDeliveryDecision(handoff, [
        { ...ci("PASS"), checks: [{ name: "test", conclusion: "FAIL" }] },
      ]),
    ).toThrow(/Malformed CI evidence/u);
    expect(() => deriveDeliveryDecision(handoff, [{ ...ci("PASS"), headRevision: null }])).toThrow(
      /Malformed CI evidence/u,
    );
  });

  it("orders CI evidence by instant rather than timestamp spelling", () => {
    const handoff = fixture().handoff;
    const earlierPass = { ...ci("PASS"), observedAt: "2026-08-21T23:00:00+14:00" };
    const laterFailure = {
      ...ci("FAIL"),
      id: "later",
      externalRunId: "later",
      observedAt: "2026-08-21T10:00:00Z",
    };
    expect(deriveDeliveryDecision(handoff, [earlierPass, laterFailure]).ciStatus).toBe("FAIL");
  });

  it("rejects head revision repaint across observations of one handoff", () => {
    const handoff = fixture().handoff;
    const pending = { ...ci("PENDING"), headRevision: "c".repeat(40) };
    const repainted = {
      ...ci("PASS"),
      id: "later",
      externalRunId: pending.externalRunId,
      observedAt: "2026-08-21T00:03:00.000Z",
      headRevision: "d".repeat(40),
    };
    expect(() => deriveDeliveryDecision(handoff, [pending, repainted])).toThrow(/head revision/u);
  });

  it("rejects a stale candidate verification and omits raw quality evidence", () => {
    const { run, task, candidate, verification } = fixture();
    expect(() =>
      buildDeliveryHandoff({
        id: "handoff",
        projectId: "project",
        run,
        task,
        candidate,
        verification: { ...verification, candidateId: "stale" },
        qualityReport: quality,
        riskVector: risk,
      }),
    ).toThrow(/verified candidate/u);
    expect(JSON.stringify(fixture().handoff)).not.toContain('evidence"');
  });
});
