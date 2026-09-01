import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertScoringEligible,
  checkProvenanceCompleteness,
  excludeNonScoring,
  NON_SCORING_TASK_IDS,
  type ScoringProvenanceRecord,
} from "../evaluation/experiments/scoring/lib/scoring-provenance";
import {
  assertStartingStateParity,
  captureSourceRevision,
  computeContentDigest,
} from "../evaluation/experiments/scoring/lib/source-revision";
import { loadFrozenTaskIds } from "../evaluation/experiments/scoring/lib/schedule";
import { analyzeScoringRuns } from "../evaluation/experiments/scoring/lib/statistics";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------ NON_SCORING exclusion

describe("NON_SCORING material can never enter scoring (Phase 19)", () => {
  it("rejects the preflight fixture task by name", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    expect(() =>
      assertScoringEligible({
        taskId: "preflight-task",
        scoringStatus: "SCORING",
        frozenTaskIds,
      }),
    ).toThrow(/NOT_PART_OF_EXPERIMENT/u);
  });

  it("rejects a NON_SCORING record even when its task id is a frozen suite task", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    expect(() =>
      assertScoringEligible({
        taskId: frozenTaskIds[0] as string,
        scoringStatus: "NON_SCORING",
        frozenTaskIds,
      }),
    ).toThrow(/only SCORING records may enter the campaign/u);
  });

  it("rejects any task outside the frozen 29-task suite", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    expect(() =>
      assertScoringEligible({
        taskId: "some-task-invented-later",
        scoringStatus: "SCORING",
        frozenTaskIds,
      }),
    ).toThrow(/not a member of the frozen 29-task suite/u);
  });

  it("accepts every genuine frozen suite task", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    for (const taskId of frozenTaskIds) {
      expect(() =>
        assertScoringEligible({ taskId, scoringStatus: "SCORING", frozenTaskIds }),
      ).not.toThrow();
    }
  });

  it("confirms no NON_SCORING fixture id collides with the frozen suite", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    for (const nonScoring of NON_SCORING_TASK_IDS) {
      expect(frozenTaskIds).not.toContain(nonScoring);
    }
  });

  it("filters preflight material out of a mixed record set", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    const mixed = [
      { taskId: frozenTaskIds[0] as string, scoringStatus: "SCORING" },
      { taskId: "preflight-task", scoringStatus: "NON_SCORING" },
      { taskId: "preflight-task", scoringStatus: "SCORING" },
      { taskId: frozenTaskIds[1] as string, scoringStatus: "NON_SCORING" },
    ];
    const kept = excludeNonScoring(mixed, frozenTaskIds);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.taskId).toBe(frozenTaskIds[0]);
  });

  it("keeps preflight observations out of the statistics entirely", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    const taskId = frozenTaskIds[0] as string;
    const runs = [1, 2, 3].flatMap((replicate) =>
      (["NATIVE", "MAF"] as const).map((arm) => ({
        taskId,
        arm,
        replicate,
        runValidity: "VALID" as const,
        infrastructureInvalid: false,
        dvs: true,
        falseSafe: false,
        hiddenGraderPass: true,
        regressionPass: true,
        candidateIntegrityValid: true,
        costUsd: 1,
        costStatus: "KNOWN" as const,
        elapsedMs: 10,
      })),
    );
    // A preflight run is filtered before analysis; it must not shift any denominator.
    const withPreflight = excludeNonScoring(
      [...runs, { ...runs[0], taskId: "preflight-task", dvs: false } as (typeof runs)[number]],
      frozenTaskIds,
    );
    const analysis = analyzeScoringRuns({
      runs: withPreflight,
      taskIds: [taskId],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(analysis.completedSlots).toBe(6);
    expect(analysis.native.dvsRate).toBe(1);
    expect(analysis.pairs.every((p) => p.taskId !== "preflight-task")).toBe(true);
  });
});

// ------------------------------------------------------- provenance schema

const completeRecord = (): ScoringProvenanceRecord =>
  ({
    protocolVersion: 2,
    protocolTag: "maf-experiment-protocol-v2",
    protocolSha: "b".repeat(40),
    suiteTag: "maf-suite-freeze-v1",
    suiteSha: "a".repeat(40),
    scoringStatus: "SCORING",
    taskId: "clamp-number-util",
    arm: "NATIVE",
    runNumber: 1,
    randomizationPosition: 14,
    requestedModel: "claude-sonnet-5",
    resolvedModel: "claude-sonnet-5",
    resolvedModelStatus: "ALIAS_ONLY",
    rawReportedModel: "claude-sonnet-5",
    modelProvenanceNote: "alias echoed",
    effort: "high",
    effortArgumentEmitted: true,
    provider: "anthropic",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:10.000Z",
    durationMs: 10_000,
    timeoutMs: 1_800_000,
    timedOut: false,
    budgetUsd: 8,
    budget: {
      mode: "HARD",
      limitUsd: 8,
      enforcementMechanism: "CLI_INTERNAL_MAX_BUDGET_FLAG",
      controllerEnforcesRealTimeCutoff: false,
      postHocStatus: "WITHIN_BUDGET",
      limitation: "documented",
    },
    usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 },
    cost: {
      participantCostUsd: 1,
      participantInputTokens: 1,
      participantOutputTokens: 2,
      participantCacheTokens: 3,
      orchestrationCostUsd: 0,
      verificationCostUsd: 0,
      totalCostUsd: 1,
      costStatus: "KNOWN",
    },
    candidateWorkspace: "C:/tmp/ws",
    attempts: [],
    ceilings: {
      runTimeoutMs: 1_800_000,
      runDeadline: "2026-09-01T00:30:00.000Z",
      remainingRunTimeMsAtEnd: 1_790_000,
      runBudgetUsd: 8,
      remainingRunBudgetUsdAtEnd: 7,
      providerInvocationsAllowed: 1,
      providerInvocationsStarted: 1,
      providerInvocationsRefused: 0,
    },
    firstFailure: null,
    failureClassification: "COMPLETED",
    executorSelfReport: {
      verificationResult: "VERIFIED",
      claimedChangedFiles: [],
      verifierFailures: 0,
    },
    candidateIntegrity: "VALID",
    hiddenGrader: "PASS",
    regression: "PASS",
    regressionEvidence: { scope: "SMOKE" },
    runValidity: "VALID",
    effectiveRunValidity: "VALID",
    infrastructureStatus: {
      executionStatus: "COMPLETED",
      infrastructureFailure: false,
      coherenceIssues: [],
    },
    dvs: true,
    runner: {
      runnerVersion: "1.0.0",
      runnerTag: "maf-scoring-runner-v1",
      runnerSha: "c".repeat(40),
    },
    slot: {
      slotId: "clamp-number-util__NATIVE__r1",
      slotDigest: "d".repeat(64),
      taskId: "clamp-number-util",
      arm: "NATIVE",
      replicate: 1,
      randomizationPosition: 14,
      sequencePosition: 84,
      generation: 0,
      attemptId: "attempt-1",
    },
    sourceRevision: {
      contentDigest: "e".repeat(64),
      fileCount: 12,
      seedCommitSha: "f".repeat(40),
      method: "CONTENT_DIGEST_AND_SEED_COMMIT",
      fixturePath: "/fixtures/task",
    },
    protocolFreezeAuthority: "GIT_TAG",
    protocolFrozen: true,
    knownSourceMetadataNote: "note",
    recoveryState: "CLEAN",
  }) as unknown as ScoringProvenanceRecord;

describe("scoring provenance completeness (Phase 16)", () => {
  it("accepts a fully populated record", () => {
    expect(checkProvenanceCompleteness(completeRecord())).toEqual({ complete: true, missing: [] });
  });

  it.each([
    ["runner", "runner.runnerTag"],
    ["slot", "slot.slotId"],
    ["sourceRevision", "sourceRevision.contentDigest"],
  ])("detects a missing %s block", (key, expectedMissing) => {
    const record = completeRecord() as unknown as Record<string, unknown>;
    delete record[key];
    const result = checkProvenanceCompleteness(record as Partial<ScoringProvenanceRecord>);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain(expectedMissing);
  });

  it("requires the runner sha field to be present even when null", () => {
    const record = completeRecord();
    record.runner = { ...record.runner, runnerSha: null };
    expect(checkProvenanceCompleteness(record).complete).toBe(true);
    const without = completeRecord() as unknown as { runner: Record<string, unknown> };
    delete without.runner.runnerSha;
    expect(
      checkProvenanceCompleteness(without as unknown as Partial<ScoringProvenanceRecord>).missing,
    ).toContain("runner.runnerSha");
  });

  it("requires the freeze authority to be recorded", () => {
    const record = completeRecord() as unknown as Record<string, unknown>;
    record.protocolFreezeAuthority = "PROSE";
    expect(
      checkProvenanceCompleteness(record as Partial<ScoringProvenanceRecord>).missing,
    ).toContain("protocolFreezeAuthority");
  });

  it("accepts ALIAS_ONLY model provenance as honest for claude-sonnet-5", () => {
    const record = completeRecord();
    expect(record.resolvedModelStatus).toBe("ALIAS_ONLY");
    expect(checkProvenanceCompleteness(record).complete).toBe(true);
  });

  it("still requires provenance fields when the cost was never measured", () => {
    const record = completeRecord();
    record.cost = {
      ...record.cost,
      participantCostUsd: null,
      totalCostUsd: null,
      costStatus: "UNKNOWN",
    };
    // An unmeasured cost is a legitimate value, not a missing field.
    expect(checkProvenanceCompleteness(record).complete).toBe(true);
  });
});

// --------------------------------------------------- source revision capture

describe("starting-state identity (Phase 9)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "maf-scoring-src-"));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("never emits UNKNOWN when the fixture is deterministically available", async () => {
    const fixture = path.join(workdir, "fixture");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), fixture, {
      recursive: true,
    });
    const identity = await captureSourceRevision({ fixturePath: fixture });
    expect(identity.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity.fileCount).toBeGreaterThan(0);
    expect(identity.method).toBe("CONTENT_DIGEST_ONLY");
  });

  it("is deterministic across identical copies of the same tree", async () => {
    const a = path.join(workdir, "a");
    const b = path.join(workdir, "b");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), a, {
      recursive: true,
    });
    await cp(a, b, { recursive: true });
    const first = await computeContentDigest(a);
    const second = await computeContentDigest(b);
    expect(first.digest).toBe(second.digest);
    expect(first.fileCount).toBe(second.fileCount);
  });

  it("changes when any file content changes", async () => {
    const dir = path.join(workdir, "tree");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), dir, {
      recursive: true,
    });
    const before = await computeContentDigest(dir);
    await writeFile(path.join(dir, "extra.txt"), "new content", "utf8");
    const after = await computeContentDigest(dir);
    expect(after.digest).not.toBe(before.digest);
    expect(after.fileCount).toBe(before.fileCount + 1);
  });

  it("proves both arms started from byte-identical material", async () => {
    const a = path.join(workdir, "native");
    const b = path.join(workdir, "maf");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), a, {
      recursive: true,
    });
    await cp(a, b, { recursive: true });
    const native = await captureSourceRevision({ fixturePath: a });
    const maf = await captureSourceRevision({ fixturePath: b });
    expect(() => assertStartingStateParity(native, maf)).not.toThrow();
  });

  it("detects a starting-state divergence between the arms", async () => {
    const a = path.join(workdir, "native");
    const b = path.join(workdir, "maf");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), a, {
      recursive: true,
    });
    await cp(a, b, { recursive: true });
    await writeFile(path.join(b, "leaked-hint.md"), "the answer is 42", "utf8");
    const native = await captureSourceRevision({ fixturePath: a });
    const maf = await captureSourceRevision({ fixturePath: b });
    expect(() => assertStartingStateParity(native, maf)).toThrow(/parity violated/u);
  });

  it("ignores .git bookkeeping so an identical tree hashes identically", async () => {
    const dir = path.join(workdir, "tree");
    await cp(path.join(repoRoot, "evaluation", "experiments", "real", "fixtures"), dir, {
      recursive: true,
    });
    const before = await computeContentDigest(dir);
    // Simulate the controller's git seed commit: .git appears, content does not change.
    await mkdir(path.join(dir, ".git", "refs"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(dir, ".git", "refs", "main"), `${"a".repeat(40)}\n`, "utf8");
    const after = await computeContentDigest(dir);
    expect(after.digest).toBe(before.digest);
    expect(after.fileCount).toBe(before.fileCount);
  });
});
