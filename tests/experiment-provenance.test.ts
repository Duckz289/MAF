import { describe, expect, it } from "vitest";
import { normalizeEvaluationRun, type EvaluationRun } from "../src/evaluation/types";
import {
  assertNonScoringExcluded,
  buildProvenanceRecord,
  type ExecutorSideChannel,
} from "../evaluation/experiments/real/lib/provenance";

const baseRun = (overrides: Partial<EvaluationRun> = {}): EvaluationRun => ({
  runId: "r1",
  condition: "NATIVE",
  model: "claude-sonnet-5",
  provider: "anthropic",
  taskId: "preflight-task",
  executionStatus: "COMPLETED",
  candidateExists: true,
  candidateIntegrity: "VALID",
  runValidity: "VALID",
  evidenceSource: "INDEPENDENT",
  hiddenGrader: "PASS",
  regression: "PASS",
  selfReported: {
    verificationResult: "VERIFIED",
    claimedChangedFiles: ["a.ts"],
    verifierFailures: 0,
  },
  claimedDone: true,
  claimedTrusted: false,
  elapsedMs: 1000,
  usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
  costUsd: 0.5,
  sourceRevision: "abc123",
  ...overrides,
});

const baseSide = (overrides: Partial<ExecutorSideChannel> = {}): ExecutorSideChannel => ({
  requestedModel: "claude-sonnet-5",
  resolvedModel: "claude-sonnet-5-20250929",
  resolvedModelStatus: "RESOLVED",
  effort: "high",
  provider: "anthropic",
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: "2026-09-01T00:00:05.000Z",
  timeout: { timeoutMs: 1_800_000, timedOut: false },
  budget: {
    mode: "HARD",
    limitUsd: 8,
    enforcementMechanism: "CLI_INTERNAL_MAX_BUDGET_FLAG",
    controllerEnforcesRealTimeCutoff: false,
    postHocStatus: "WITHIN_BUDGET",
    limitation: "test",
  },
  cost: {
    participantCostUsd: 0.5,
    participantInputTokens: 100,
    participantOutputTokens: 50,
    participantCacheTokens: 0,
    orchestrationCostUsd: 0,
    verificationCostUsd: 0,
    totalCostUsd: 0.5,
    costStatus: "KNOWN",
  },
  candidateWorkspace: "/tmp/fake-workspace",
  ...overrides,
});

const buildRecord = (
  run: EvaluationRun,
  side: ExecutorSideChannel,
  scoringStatus: "NON_SCORING" | "SCORING" = "NON_SCORING",
) =>
  buildProvenanceRecord({
    scoringStatus,
    protocolTag: "maf-experiment-protocol-v1",
    protocolSha: "b183b20a08b1d4f6902bffea49fe139f80cad4e9",
    suiteTag: "maf-suite-freeze-v1",
    suiteSha: "92f13ae67802dd0049ca001f70839a9451120900",
    runNumber: 1,
    randomizationPosition: null,
    arm: "NATIVE",
    normalized: normalizeEvaluationRun(run),
    side,
  });

describe("buildProvenanceRecord", () => {
  it("carries independent-evidence dvs=true through when everything passes", () => {
    const record = buildRecord(baseRun(), baseSide());
    expect(record.dvs).toBe(true);
    expect(record.hiddenGrader).toBe("PASS");
    expect(record.regression).toBe("PASS");
  });

  it("records a hidden grader FAIL as dvs=false without touching regression", () => {
    const record = buildRecord(baseRun({ hiddenGrader: "FAIL" }), baseSide());
    expect(record.dvs).toBe(false);
    expect(record.hiddenGrader).toBe("FAIL");
  });

  it("blocks DVS when regression is NOT_CHECKED, even with hiddenGrader PASS", () => {
    const record = buildRecord(baseRun({ regression: "NOT_CHECKED" }), baseSide());
    expect(record.dvs).toBe(false);
    expect(record.regression).toBe("NOT_CHECKED");
  });

  it("records a missing candidate as candidateIntegrity MISSING and dvs=false", () => {
    const record = buildRecord(
      baseRun({
        candidateExists: false,
        candidateIntegrity: "MISSING",
        hiddenGrader: "NOT_CHECKED",
        regression: "NOT_CHECKED",
        claimedDone: false,
      }),
      baseSide(),
    );
    expect(record.candidateIntegrity).toBe("MISSING");
    expect(record.dvs).toBe(false);
  });

  it("detects self-report disagreement (claimed success, independently FAILed) as a false safe", () => {
    const run = baseRun({ hiddenGrader: "FAIL", claimedDone: true });
    const normalized = normalizeEvaluationRun(run);
    expect(normalized.dvs).toBe(false);
    expect(normalized.falseSafe).toBe(true);
    const record = buildRecord(run, baseSide());
    expect(record.executorSelfReport?.verificationResult).toBe("VERIFIED");
    expect(record.dvs).toBe(false);
  });

  it("never turns an UNKNOWN cost into a fabricated zero", () => {
    const side = baseSide({
      cost: {
        participantCostUsd: null,
        participantInputTokens: 0,
        participantOutputTokens: 0,
        participantCacheTokens: 0,
        orchestrationCostUsd: 0,
        verificationCostUsd: 0,
        totalCostUsd: null,
        costStatus: "UNKNOWN",
        note: "no usage event observed",
      },
    });
    const record = buildRecord(baseRun(), side);
    expect(record.cost.participantCostUsd).toBeNull();
    expect(record.cost.totalCostUsd).toBeNull();
    expect(record.cost.costStatus).toBe("UNKNOWN");
  });

  it("propagates coherence issues rather than silently dropping them", () => {
    // executionStatus TIMEOUT with grading fields left at PASS is internally inconsistent; the
    // normalizer downgrades rather than trusting it, and records the contradiction it found.
    const run = baseRun({ executionStatus: "TIMEOUT" });
    const normalized = normalizeEvaluationRun(run);
    expect(normalized.coherenceIssues.length).toBeGreaterThan(0);
    const record = buildRecord(run, baseSide());
    expect(record.infrastructureStatus.coherenceIssues.length).toBeGreaterThan(0);
    expect(record.infrastructureStatus.infrastructureFailure).toBe(true);
  });
});

describe("assertNonScoringExcluded", () => {
  it("allows a NON_SCORING record whose taskId never collides with the frozen suite", () => {
    const record = buildRecord(baseRun(), baseSide(), "NON_SCORING");
    expect(() =>
      assertNonScoringExcluded(record, ["clamp-number-util", "csv-export-feature"]),
    ).not.toThrow();
  });

  it("throws if a NON_SCORING record's taskId collides with a frozen scoring task id", () => {
    const record = buildRecord(baseRun({ taskId: "clamp-number-util" }), baseSide(), "NON_SCORING");
    expect(() => assertNonScoringExcluded(record, ["clamp-number-util"])).toThrow(/collides/);
  });

  it("never checks a SCORING record (nothing to exclude)", () => {
    const record = buildRecord(baseRun({ taskId: "clamp-number-util" }), baseSide(), "SCORING");
    expect(() => assertNonScoringExcluded(record, ["clamp-number-util"])).not.toThrow();
  });
});
