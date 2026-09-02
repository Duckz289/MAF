import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executePairedSlots,
  pairSlots,
  REQUIRED_SPAWN_ARGS,
  verifySpawnArgv,
} from "../evaluation/experiments/scoring/lib/participant-runner";
import { buildScoringSchedule, type RunSlot } from "../evaluation/experiments/scoring/lib/schedule";
import { ScoringStateStore } from "../evaluation/experiments/scoring/lib/state-store";
import { checkProvenanceCompleteness } from "../evaluation/experiments/scoring/lib/scoring-provenance";
import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  FROZEN_PARAMETERS,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import type { ExperimentProvenanceRecord } from "../evaluation/experiments/real/lib/provenance";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fakeCliPath = path.join(here, "fixtures", "fake-claude-cli.mjs");
const preflightFixture = path.join(
  repoRoot,
  "evaluation",
  "experiments",
  "real",
  "fixtures",
  "preflight-phase",
  "preflight-task",
  "public",
  "repo",
);

// A two-task synthetic suite; the frozen 29-task suite is never touched by these tests.
const schedule = buildScoringSchedule({
  randomization: {
    seed: "participant-runner-test",
    taskOrder: ["alpha-task", "beta-task"],
    armOrder: { "alpha-task": "NATIVE_FIRST", "beta-task": "MAF_FIRST" },
  },
  frozenTaskIds: ["alpha-task", "beta-task"],
  runsPerTask: 3,
});
const FROZEN_TASK_IDS = ["alpha-task", "beta-task"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "maf-scoring-participant-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const firstPair = () => {
  const pairs = pairSlots(schedule.slots.filter((s) => s.taskId === "alpha-task"));
  return pairs[0] as { native: RunSlot; maf: RunSlot };
};

/**
 * Runs one paired slot against the FAKE CLI. No real provider is ever contacted: the adapter's
 * script-command hook runs the fixture through node, and the fixture only ever emits canned
 * stream-json.
 */
const runWithFakeCli = async (options: { store: ScoringStateStore; runnerSha?: string | null }) =>
  executePairedSlots(
    {
      repoRoot,
      store: options.store,
      frozenTaskIds: FROZEN_TASK_IDS,
      claudeCommand: fakeCliPath,
      runnerSha: options.runnerSha ?? null,
      fixtureRootResolver: () => preflightFixture,
      // No hidden grader exists for the synthetic task ids, so verification reports NOT_CHECKED --
      // which is exactly right: a run the controller could not independently verify must never be
      // a DVS.
      verifierLocate: () => null,
    },
    firstPair(),
    {
      prompt: "Fix formatName so it returns `${last}, ${first}`.",
      expectedVerification: 'formatName("Ada", "Lovelace") === "Lovelace, Ada"',
    },
  );

describe("pairing the frozen schedule into execution units", () => {
  it("groups each task+replicate into one Native/MAF pair", () => {
    const pairs = pairSlots(schedule.slots);
    expect(pairs).toHaveLength(6); // 2 tasks x 3 replicates
    for (const pair of pairs) {
      expect(pair.native.arm).toBe("NATIVE");
      expect(pair.maf.arm).toBe("MAF");
      expect(pair.native.taskId).toBe(pair.maf.taskId);
      expect(pair.native.replicate).toBe(pair.maf.replicate);
    }
  });

  it("preserves frozen schedule order across pairs", () => {
    const pairs = pairSlots(schedule.slots);
    const positions = pairs.map((p) => Math.min(p.native.sequencePosition, p.maf.sequencePosition));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(pairs[0]?.native.taskId).toBe("alpha-task");
  });

  it("drops an unpaired slot rather than executing half a pair", () => {
    const onlyNative = schedule.slots.filter((s) => s.arm === "NATIVE");
    expect(pairSlots(onlyNative)).toHaveLength(0);
  });
});

describe("argv proof for the frozen controlled variables", () => {
  const provenanceWithArgs = (args: string[] | null): ExperimentProvenanceRecord =>
    ({
      attempts: [
        {
          attempt: 1,
          started: true,
          spawn: args ? { command: "claude", args } : null,
        },
      ],
    }) as unknown as ExperimentProvenanceRecord;

  it("requires --model claude-sonnet-5 and --effort high", () => {
    expect([...REQUIRED_SPAWN_ARGS]).toEqual([
      ["--model", "claude-sonnet-5"],
      ["--effort", "high"],
    ]);
  });

  it("passes when both controlled variables are present in argv", () => {
    const check = verifySpawnArgv(
      provenanceWithArgs(["-p", "--model", "claude-sonnet-5", "--effort", "high"]),
    );
    expect(check.ok).toBe(true);
  });

  it("fails when --effort was recorded in provenance but never emitted (the preflight defect)", () => {
    const check = verifySpawnArgv(provenanceWithArgs(["-p", "--model", "claude-sonnet-5"]));
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("--effort high");
  });

  it("fails when the model is not the frozen one", () => {
    const check = verifySpawnArgv(
      provenanceWithArgs(["-p", "--model", "claude-opus-5", "--effort", "high"]),
    );
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("--model claude-sonnet-5");
  });

  it("fails when no attempt was started at all", () => {
    const check = verifySpawnArgv({ attempts: [] } as unknown as ExperimentProvenanceRecord);
    expect(check.ok).toBe(false);
    expect(check.observedArgs).toBeNull();
  });
});

describe("real executor composition against a FAKE CLI", () => {
  it("executes a pair and proves BOTH arms spawned the frozen model and effort", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store });

    expect(result.status).toBe("EXECUTED");
    if (result.status !== "EXECUTED") return;

    expect(result.argv.native.ok).toBe(true);
    expect(result.argv.maf.ok).toBe(true);
    expect(result.argv.native.observedArgs).toEqual(
      expect.arrayContaining(["--model", "claude-sonnet-5", "--effort", "high"]),
    );
    expect(result.argv.maf.observedArgs).toEqual(
      expect.arrayContaining(["--model", "claude-sonnet-5", "--effort", "high"]),
    );
  });

  it("applies identical frozen ceilings and permission mode to both arms", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store });
    if (result.status !== "EXECUTED") throw new Error("expected execution");

    for (const record of [result.nativeProvenance, result.mafProvenance]) {
      expect(record.requestedModel).toBe(FROZEN_PARAMETERS.model);
      expect(record.effort).toBe(FROZEN_PARAMETERS.effort);
      expect(record.effortArgumentEmitted).toBe(true);
      expect(record.provider).toBe(FROZEN_PARAMETERS.provider);
      expect(record.timeoutMs).toBe(FROZEN_PARAMETERS.timeoutMs);
      expect(record.budgetUsd).toBe(FROZEN_PARAMETERS.perRunCeilingUsd);
      const args = record.attempts.find((a) => a.started)?.spawn?.args ?? [];
      expect(args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
      expect(args).toEqual(
        expect.arrayContaining(["--max-budget-usd", String(FROZEN_PARAMETERS.perRunCeilingUsd)]),
      );
    }
  });

  it("records a determinate starting source revision for both arms, never UNKNOWN", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store });
    if (result.status !== "EXECUTED") throw new Error("expected execution");

    for (const record of [result.nativeProvenance, result.mafProvenance]) {
      expect(record.sourceRevision.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(record.sourceRevision.fileCount).toBeGreaterThan(0);
      expect(JSON.stringify(record.sourceRevision)).not.toContain("UNKNOWN");
    }
    // Parity: both arms started from byte-identical material.
    expect(result.nativeProvenance.sourceRevision.contentDigest).toBe(
      result.mafProvenance.sourceRevision.contentDigest,
    );
  });

  it("stamps suite, protocol, analysis, runner and slot identity on every observation", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store, runnerSha: "c".repeat(40) });
    if (result.status !== "EXECUTED") throw new Error("expected execution");

    for (const record of [result.nativeProvenance, result.mafProvenance]) {
      expect(record.scoringStatus).toBe("SCORING");
      expect(record.suiteTag).toBe("maf-suite-freeze-v1");
      expect(record.protocolTag).toBe("maf-experiment-protocol-v2");
      expect(record.analysis.analysisTag).toBe(ANALYSIS_TAG);
      expect(record.analysis.analysisSha).toBe(ANALYSIS_SHA);
      expect(record.analysis.analysisVersion).toBe("1.0.0");
      expect(record.runner.runnerTag).toBe("maf-scoring-runner-v1");
      expect(record.runner.runnerSha).toBe("c".repeat(40));
      expect(record.slot.slotDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(record.protocolFreezeAuthority).toBe("GIT_TAG");
      expect(checkProvenanceCompleteness(record)).toEqual({ complete: true, missing: [] });
    }
  });

  it("persists both observations with analysis identity and closes the ambiguity window", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    await runWithFakeCli({ store });

    for (const slot of [pair.native, pair.maf]) {
      const state = await store.inspectSlot(slot.slotId);
      expect(state.status).toBe("COMPLETE");
      expect(state.danglingIntents).toHaveLength(0);
      expect(state.observations).toHaveLength(1);
      expect(state.observations[0]?.analysisTag).toBe(ANALYSIS_TAG);
      expect(state.observations[0]?.analysisSha).toBe(ANALYSIS_SHA);
    }
  });

  it("does not mint a DVS when the controller could not independently verify the candidate", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store });
    if (result.status !== "EXECUTED") throw new Error("expected execution");
    // The fake CLI reports success; without independent verification that must not become a DVS.
    for (const record of [result.nativeProvenance, result.mafProvenance]) {
      expect(record.dvs).toBe(false);
    }
  });

  it("refuses to re-execute a completed pair", async () => {
    const store = new ScoringStateStore({ root });
    await runWithFakeCli({ store });
    const second = await runWithFakeCli({ store });
    expect(second.status).toBe("REFUSED");
    if (second.status === "REFUSED") expect(second.reason).toBe("COMPLETE");
  });

  it("refuses before spawning when the MAF slot is unavailable", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    // Another process already holds the MAF half of the pair.
    const other = new ScoringStateStore({ root, owner: "other-process" });
    expect((await other.claimSlot(pair.maf)).claimed).toBe(true);

    const result = await runWithFakeCli({ store });
    expect(result.status).toBe("REFUSED");
    // Nothing was spawned for either arm: no intent record exists anywhere.
    const nativeState = await store.inspectSlot(pair.native.slotId);
    expect(nativeState.danglingIntents).toHaveLength(0);
    expect(nativeState.observations).toHaveLength(0);
  });
});

describe("NON_SCORING and out-of-suite tasks can never be executed", () => {
  it("throws before any claim when the task is not in the frozen suite", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    await expect(
      executePairedSlots(
        {
          repoRoot,
          store,
          frozenTaskIds: ["some-other-task"],
          claudeCommand: fakeCliPath,
          runnerSha: null,
          fixtureRootResolver: () => preflightFixture,
          verifierLocate: () => null,
        },
        pair,
        { prompt: "x", expectedVerification: "y" },
      ),
    ).rejects.toThrow(/not a member of the frozen 29-task suite/u);
    // No reservation was created.
    expect((await store.inspectSlot(pair.native.slotId)).status).toBe("PLANNED");
  });

  it("throws for the preflight fixture task id", async () => {
    const store = new ScoringStateStore({ root });
    const preflightSchedule = buildScoringSchedule({
      randomization: {
        seed: "s",
        taskOrder: ["preflight-task"],
        armOrder: { "preflight-task": "NATIVE_FIRST" },
      },
      frozenTaskIds: ["preflight-task"],
      runsPerTask: 3,
    });
    const pair = pairSlots(preflightSchedule.slots)[0] as { native: RunSlot; maf: RunSlot };
    await expect(
      executePairedSlots(
        {
          repoRoot,
          store,
          frozenTaskIds: ["preflight-task"],
          claudeCommand: fakeCliPath,
          runnerSha: null,
          fixtureRootResolver: () => preflightFixture,
          verifierLocate: () => null,
        },
        pair,
        { prompt: "x", expectedVerification: "y" },
      ),
    ).rejects.toThrow(/NOT_PART_OF_EXPERIMENT/u);
  });
});
