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
import {
  issueProviderAuthorization,
  type ExecutionGateDecision,
  type ProviderAuthorization,
} from "../evaluation/experiments/scoring/lib/execution-gate";
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
const CAMPAIGN_ID = "campaign-under-test";

const authorizedDecision = (): ExecutionGateDecision => ({
  authorized: true,
  checks: [],
  failures: [],
  protocolFreezeAuthority: "GIT_TAG",
  protocolFrozen: true,
  knownSourceMetadataNote: "note",
  summary: "all gates passed",
});

const refusedDecision = (): ExecutionGateDecision => ({
  authorized: false,
  checks: [{ id: "RUNNER_FROZEN", passed: false, detail: "runner tag absent" }],
  failures: [{ id: "RUNNER_FROZEN", passed: false, detail: "runner tag absent" }],
  protocolFreezeAuthority: "GIT_TAG",
  protocolFrozen: true,
  knownSourceMetadataNote: "note",
  summary: "1 of 14 gates failed",
});

/** Mints a real capability for the given pair. There is no way to forge one. */
const authorizationFor = (
  pair: { native: RunSlot; maf: RunSlot },
  overrides: Partial<{ campaignId: string; scheduleDigest: string }> = {},
): ProviderAuthorization => {
  const auth = issueProviderAuthorization({
    decision: authorizedDecision(),
    campaignId: overrides.campaignId ?? CAMPAIGN_ID,
    scheduleDigest: overrides.scheduleDigest ?? schedule.scheduleDigest,
    nativeSlotDigest: pair.native.slotDigest,
    mafSlotDigest: pair.maf.slotDigest,
    executablePath: fakeCliPath,
  });
  if (!auth) throw new Error("expected a capability to be issued");
  return auth;
};

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
const runWithFakeCli = async (options: {
  store: ScoringStateStore;
  runnerSha?: string | null;
  authorization?: ProviderAuthorization;
}) =>
  executePairedSlots(
    {
      repoRoot,
      store: options.store,
      frozenTaskIds: FROZEN_TASK_IDS,
      claudeCommand: fakeCliPath,
      runnerSha: options.runnerSha ?? null,
      campaignId: CAMPAIGN_ID,
      scheduleDigest: schedule.scheduleDigest,
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
      authorization: options.authorization ?? authorizationFor(firstPair()),
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

describe("the provider boundary enforces authorization itself", () => {
  const baseConfig = (store: ScoringStateStore) => ({
    repoRoot,
    store,
    frozenTaskIds: FROZEN_TASK_IDS,
    claudeCommand: fakeCliPath,
    runnerSha: null,
    campaignId: CAMPAIGN_ID,
    scheduleDigest: schedule.scheduleDigest,
    fixtureRootResolver: () => preflightFixture,
    verifierLocate: () => null,
  });

  it("refuses a direct call with NO authorization, before any claim or spawn", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    await expect(
      executePairedSlots(baseConfig(store), pair, {
        prompt: "x",
        expectedVerification: "y",
        // Simulates a caller that forgot the capability entirely.
        authorization: undefined as unknown as ProviderAuthorization,
      }),
    ).rejects.toThrow(/no provider authorization was supplied/u);

    // Nothing was claimed and nothing was spawned.
    expect((await store.inspectSlot(pair.native.slotId)).status).toBe("PLANNED");
    expect((await store.inspectSlot(pair.maf.slotId)).status).toBe("PLANNED");
  });

  it("refuses a capability minted from a REFUSED gate decision", () => {
    // Such a capability cannot even be created -- the mint returns null.
    expect(
      issueProviderAuthorization({
        decision: refusedDecision(),
        campaignId: CAMPAIGN_ID,
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: firstPair().native.slotDigest,
        mafSlotDigest: firstPair().maf.slotDigest,
        executablePath: fakeCliPath,
      }),
    ).toBeNull();
  });

  it("refuses an authorization issued for a DIFFERENT pair, before spawning", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    const otherPair = pairSlots(schedule.slots.filter((s) => s.taskId === "beta-task"))[0] as {
      native: RunSlot;
      maf: RunSlot;
    };
    await expect(
      executePairedSlots(baseConfig(store), pair, {
        prompt: "x",
        expectedVerification: "y",
        authorization: authorizationFor(otherPair),
      }),
    ).rejects.toThrow(/issued for a different execution/u);
    expect((await store.inspectSlot(pair.native.slotId)).status).toBe("PLANNED");
  });

  it("refuses an authorization from a different campaign", async () => {
    const store = new ScoringStateStore({ root });
    await expect(
      executePairedSlots(baseConfig(store), firstPair(), {
        prompt: "x",
        expectedVerification: "y",
        authorization: authorizationFor(firstPair(), { campaignId: "another-campaign" }),
      }),
    ).rejects.toThrow(/campaign/u);
  });

  it("reaches the FAKE CLI only with a correctly bound authorization", async () => {
    const store = new ScoringStateStore({ root });
    const result = await runWithFakeCli({ store });
    expect(result.status).toBe("EXECUTED");
  });
});

describe("pre-spawn failure settles intents instead of stranding them", () => {
  it("records never-started outcomes when preparation fails after intent", async () => {
    const store = new ScoringStateStore({ root });
    const pair = firstPair();
    const result = await executePairedSlots(
      {
        repoRoot,
        store,
        frozenTaskIds: FROZEN_TASK_IDS,
        claudeCommand: fakeCliPath,
        runnerSha: null,
        campaignId: CAMPAIGN_ID,
        scheduleDigest: schedule.scheduleDigest,
        // A fixture path that does not exist: preparation fails after intents are written.
        fixtureRootResolver: () => path.join(root, "no-such-fixture"),
        verifierLocate: () => null,
      },
      pair,
      {
        prompt: "x",
        expectedVerification: "y",
        authorization: authorizationFor(pair),
      },
    );

    expect(result.status).toBe("REFUSED");
    if (result.status === "REFUSED") expect(result.reason).toBe("PRE_SPAWN_FAILURE");

    // The slots must NOT be stranded in RECOVERY_REQUIRED: nothing could have been billed, and the
    // outcome records say so explicitly.
    for (const slot of [pair.native, pair.maf]) {
      const state = await store.inspectSlot(slot.slotId);
      expect(state.danglingIntents).toHaveLength(0);
      expect(state.status).not.toBe("RECOVERY_REQUIRED");
    }
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
          campaignId: CAMPAIGN_ID,
          scheduleDigest: schedule.scheduleDigest,
          fixtureRootResolver: () => preflightFixture,
          verifierLocate: () => null,
        },
        pair,
        { prompt: "x", expectedVerification: "y", authorization: authorizationFor(pair) },
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
          campaignId: CAMPAIGN_ID,
          scheduleDigest: preflightSchedule.scheduleDigest,
          fixtureRootResolver: () => preflightFixture,
          verifierLocate: () => null,
        },
        pair,
        {
          prompt: "x",
          expectedVerification: "y",
          authorization: issueProviderAuthorization({
            decision: authorizedDecision(),
            campaignId: CAMPAIGN_ID,
            scheduleDigest: preflightSchedule.scheduleDigest,
            nativeSlotDigest: pair.native.slotDigest,
            mafSlotDigest: pair.maf.slotDigest,
            executablePath: fakeCliPath,
          }) as ProviderAuthorization,
        },
      ),
    ).rejects.toThrow(/NOT_PART_OF_EXPERIMENT/u);
  });
});
