// RUNNER v2 STRUCTURAL PROVIDER ISOLATION -- the incident regression suite.
//
// Incident maf-scoring-incident-2026-09-03-v1 (895797e0c58099c763e206b851ba144d287394db) was not
// caused by a gate that failed to fire. Every gate fired correctly. It was caused by a test whose
// safety was a fact about the OUTSIDE WORLD -- `maf-scoring-runner-v1` did not exist yet -- and the
// freeze ceremony is precisely the event that makes that fact false. When the tag was created, the
// test's own assertions became unreachable and its invocation billed six frozen-suite runs of
// idempotency-key-race against the operator's real Claude Code subscription.
//
// This file proves the replacement property, which no tag, remote, or future repository state can
// invalidate:
//
//   A TEST MAY NOT SPAWN A REAL PROVIDER, EVEN WHEN EVERY OTHER CONDITION FOR BILLED SCORING IS
//   SATISFIED -- freeze gates valid, billed confirmation supplied, budget available, auth
//   first-party, worktree clean.
//
// The suite is organised as the mission's test matrix, then a final block that reproduces the
// incident's exact conditions and counts provider spawns.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveTestDoubleProvider,
  assertProviderIdentityForSpawn,
  detectExecutionContext,
  observeTestDoubleMarker,
  resolveRealProviderIdentity,
  TEST_DOUBLE_MARKER,
  TEST_DOUBLE_ROOT_MARKER_FILE,
  type ExecutionContext,
  type ProviderIdentity,
} from "../evaluation/experiments/scoring/lib/provider-identity";
import {
  issueProviderAuthorization,
  type ExecutionGateDecision,
} from "../evaluation/experiments/scoring/lib/execution-gate";
import {
  executePairedSlots,
  pairSlots,
} from "../evaluation/experiments/scoring/lib/participant-runner";
import { buildScoringSchedule, type RunSlot } from "../evaluation/experiments/scoring/lib/schedule";
import { ScoringStateStore } from "../evaluation/experiments/scoring/lib/state-store";
import {
  INCIDENT_SHA,
  INCIDENT_TAG,
  RUNNER_TAG,
  RUNNER_V1_SHA,
  RUNNER_V1_STATUS,
  RUNNER_V1_TAG,
  RUNNER_VERSION,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import { approvedTestDouble, FAKE_CLAUDE_CLI } from "./helpers/test-double-provider";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "evaluation", "experiments", "scoring", "run-scoring.ts");
const approvedFixture = path.join(here, "fixtures", "scoring-test-fixture.mjs");

/**
 * A path that NAMES the real first-party Claude Code CLI.
 *
 * Used only as an argument to refusal assertions. Nothing in this file executes it, and the
 * approval path rejects it on its basename before it would ever be opened.
 */
const REAL_CLAUDE_PATH =
  process.platform === "win32"
    ? "C:\\Users\\Admin\\.local\\bin\\claude.exe"
    : "/usr/local/bin/claude";

let scratch: string;
let campaign: string;
/** A home directory with no Claude settings, so config checks are machine-independent. */
let cleanHome: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "maf-v2-isolation-"));
  campaign = path.join(scratch, "campaign");
  cleanHome = path.join(scratch, "home");
  await mkdir(cleanHome, { recursive: true });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * Environment for a simulated invocation: the operator's own routing REMOVED.
 *
 * The scoring gates inspect three configuration surfaces -- this process's ANTHROPIC_* variables,
 * what would be forwarded to the participant, and the Claude CLI's own active settings files. All
 * three are properties of whoever happens to be running the suite, and a simulation whose result
 * depended on them would be exactly the class of defect this file exists to prevent: a test whose
 * behaviour is a fact about the outside world.
 *
 * So the child gets no ANTHROPIC_* routing and a home directory containing no Claude settings. This
 * makes the simulated world deterministic on any machine. It weakens nothing: the checks still run,
 * in full, against the environment presented -- and the REAL-repository cases below deliberately do
 * not use this, so they observe the machine as it actually is.
 */
const simulationEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_")) delete env[key];
  }
  env.USERPROFILE = cleanHome;
  env.HOME = cleanHome;
  return { ...env, ...extra };
};

// ---------------------------------------------------------------- subprocess harness

const runCli = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> => {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), cli, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 20 * 1024 * 1024,
        env: simulationEnv({ MAF_SIM_HEAD: "a".repeat(40), ...env }),
      },
    );
    return { stdout, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.code ?? 1 };
  }
};

/** Counts participant spawns by counting persisted provider-start intents. */
const countIntents = async (root: string): Promise<number> => {
  const { readdir } = await import("node:fs/promises");
  const slots = await readdir(path.join(root, "slots")).catch(() => [] as string[]);
  let total = 0;
  for (const slotId of slots) {
    const intents = await readdir(path.join(root, "slots", slotId, "intents")).catch(
      () => [] as string[],
    );
    total += intents.filter((f) => f.endsWith(".json")).length;
  }
  return total;
};

const initCampaign = async (): Promise<void> => {
  const result = await runCli([
    "init",
    "--campaign",
    campaign,
    "--ceiling-usd",
    "100",
    "--test-fixture",
    approvedFixture,
  ]);
  expect(result.stdout).toMatch(/campaign initialized/u);
};

/**
 * Writes a test-seam module that keeps the approved fixture's VALID simulated git state but
 * substitutes a different provider. Every freeze gate therefore still passes, isolating the provider
 * question -- which is exactly the shape of the incident.
 */
const fixtureWithProvider = async (name: string, providerExpression: string): Promise<string> => {
  const file = path.join(scratch, `${name}.mjs`);
  const approvedUrl = new URL(`file:///${approvedFixture.replace(/\\/gu, "/")}`).href;
  await writeFile(
    file,
    `export { git, resolve, checkAuth, participantFixtureRoot } from ${JSON.stringify(approvedUrl)};\n` +
      `export const testDoubleProviderPath = ${providerExpression};\n`,
    "utf8",
  );
  return file;
};

/** A fixture module deliberately missing the provider seam entirely. */
const fixtureWithoutProvider = async (): Promise<string> => {
  const file = path.join(scratch, "no-provider.mjs");
  const approvedUrl = new URL(`file:///${approvedFixture.replace(/\\/gu, "/")}`).href;
  await writeFile(
    file,
    `export { git, resolve, checkAuth, participantFixtureRoot } from ${JSON.stringify(approvedUrl)};\n`,
    "utf8",
  );
  return file;
};

const billed = (fixture: string | null): string[] => [
  "execute",
  "--campaign",
  campaign,
  "--confirm-billed-scoring",
  "--tasks",
  "1",
  ...(fixture ? ["--test-fixture", fixture] : []),
];

// =============================================================== TEST MATRIX

describe("MATRIX: fake Git + approved fake executable -> simulation allowed", () => {
  it("authorizes and spawns the TEST DOUBLE, never a real provider", async () => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture));
    expect(result.stdout).toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    expect(result.stdout).toMatch(/fake-claude-cli\.mjs/u);
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
    expect(await countIntents(campaign)).toBe(2);
  }, 300_000);
});

describe("MATRIX: fake Git without an approved provider -> refuse, ZERO spawns", () => {
  const expectRefusal = async (fixture: string | null, pattern: RegExp) => {
    await initCampaign();
    const result = await runCli(billed(fixture));
    expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(result.stdout).toMatch(pattern);
    expect(result.stdout).not.toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).not.toMatch(/EXECUTED /u);
    expect(await countIntents(campaign)).toBe(0);
  };

  it("no fake executable supplied at all -> refuse", async () => {
    await expectRefusal(await fixtureWithoutProvider(), /TEST_SEAM_INCOMPLETE/u);
  }, 300_000);

  it("bare `claude` instead of an absolute path -> refuse", async () => {
    await expectRefusal(
      await fixtureWithProvider("bare-claude", '"claude"'),
      /REAL_CLAUDE_EXECUTABLE|NOT_ABSOLUTE/u,
    );
  }, 300_000);

  it("the REAL Claude executable path -> refuse in test mode", async () => {
    await expectRefusal(
      await fixtureWithProvider("real-claude", JSON.stringify(REAL_CLAUDE_PATH)),
      /REAL_CLAUDE_EXECUTABLE/u,
    );
  }, 300_000);

  it("an executable with no TEST_DOUBLE marker -> refuse", async () => {
    const unmarked = path.join(scratch, "unmarked-cli.mjs");
    await writeFile(unmarked, "process.exit(0);\n", "utf8");
    await writeFile(path.join(scratch, TEST_DOUBLE_ROOT_MARKER_FILE), "root\n", "utf8");
    await expectRefusal(
      await fixtureWithProvider("unmarked", JSON.stringify(unmarked)),
      /MARKER_ABSENT/u,
    );
  }, 300_000);

  it("a marked executable outside any declared fixture root -> refuse", async () => {
    const orphanDir = await mkdtemp(path.join(tmpdir(), "maf-orphan-"));
    const orphan = path.join(orphanDir, "orphan-cli.mjs");
    await writeFile(orphan, `// ${TEST_DOUBLE_MARKER}\nprocess.exit(0);\n`, "utf8");
    try {
      await expectRefusal(
        await fixtureWithProvider("orphan", JSON.stringify(orphan)),
        /ROOT_MARKER_ABSENT/u,
      );
    } finally {
      await rm(orphanDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 300_000);

  it("an executable that does not exist -> refuse", async () => {
    await expectRefusal(
      await fixtureWithProvider("missing", JSON.stringify(path.join(scratch, "nope.mjs"))),
      /NOT_A_FILE/u,
    );
  }, 300_000);
});

describe("MATRIX: real Git state under test", () => {
  it("real Git + --confirm-billed-scoring -> REFUSE before anything resolves", async () => {
    // THIS IS THE INCIDENT COMMAND LINE, verbatim in shape: the real repository, billed
    // confirmation, no fixture of any kind.
    await initCampaign();
    const result = await runCli(billed(null));
    expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(result.stdout).toMatch(/TEST_CONTEXT_WITHOUT_TEST_PROVIDER/u);
    expect(result.stdout).toMatch(/No executable was resolved, no probe was run/u);
    expect(await countIntents(campaign)).toBe(0);
  }, 300_000);

  it("real Git + no billed confirmation -> validation only, no gate evaluated", async () => {
    const result = await runCli(["validate"]);
    expect(result.stdout).toMatch(/SCORING_PLAN_VALID|SCORING_PLAN_INVALID/u);
    expect(result.stdout).not.toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).not.toMatch(/EXECUTED /u);
  }, 120_000);
});

describe("MATRIX: tag state cannot influence test safety", () => {
  // The heart of mission Repair 3. Runner v1's tag IS present on the real machine, and v2's will be
  // one day; neither may change what a test can reach.
  it("Runner v1 tag present on the real repository does not enable any test spawn", async () => {
    const localV1 = await execFileAsync("git", ["rev-list", "-n1", RUNNER_V1_TAG], {
      cwd: repoRoot,
      encoding: "utf8",
    }).catch(() => null);
    // The real repository genuinely holds the v1 tag at the incident-era commit.
    expect(localV1?.stdout.trim()).toBe(RUNNER_V1_SHA);

    await initCampaign();
    const result = await runCli(billed(null));
    expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(await countIntents(campaign)).toBe(0);
  }, 300_000);

  it.each([
    "",
    "FUTURE_TAGS_PRESENT",
    "RUNNER_V1_ONLY",
  ])("simulated tag world %s never yields a real provider", async (variant) => {
    await initCampaign();
    const result = await runCli(
      billed(approvedFixture),
      variant ? { MAF_SIM_VARIANT: variant } : {},
    );
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
    if (result.stdout.includes("SCORING_EXECUTION_AUTHORIZED")) {
      expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    }
  }, 300_000);
});

// ================================================= PROVIDER BOUNDARY (in-process)

describe("PROVIDER BOUNDARY: the interlock holds against direct invocation", () => {
  let testDouble: ProviderIdentity;
  beforeAll(async () => {
    testDouble = await approvedTestDouble();
  });

  const PRODUCTION: ExecutionContext = {
    kind: "PRODUCTION",
    signals: [],
    detail: "synthetic production context",
  };

  it("refuses when no identity is supplied at all", () => {
    expect(() =>
      assertProviderIdentityForSpawn(undefined, { executablePath: FAKE_CLAUDE_CLI }),
    ).toThrow(/no provider identity was supplied/u);
  });

  it("REFUSES a REAL_PROVIDER identity at a boundary reached under test", () => {
    // A capability claiming to be for the real provider, minted in a synthetic PRODUCTION context,
    // then presented at a boundary that re-detects the LIVE context (vitest => TEST).
    const outcome = resolveRealProviderIdentity({
      executablePath: REAL_CLAUDE_PATH,
      context: PRODUCTION,
    });
    expect(outcome.approved).toBe(true);
    const identity = (outcome as { approved: true; identity: ProviderIdentity }).identity;
    expect(identity.kind).toBe("REAL_PROVIDER_EXECUTION");

    expect(() =>
      assertProviderIdentityForSpawn(identity, { executablePath: REAL_CLAUDE_PATH }),
    ).toThrow(/TEST execution context .* with provider identity REAL_PROVIDER_EXECUTION/su);
  });

  it("REFUSES a real-provider identity even when the freeze world looks perfect", () => {
    // Capability claims TEST but the executable is REAL: refused because identity kind, not
    // intention, is what the boundary reads.
    const outcome = resolveRealProviderIdentity({
      executablePath: REAL_CLAUDE_PATH,
      context: PRODUCTION,
    });
    const identity = (outcome as { approved: true; identity: ProviderIdentity }).identity;
    expect(() =>
      assertProviderIdentityForSpawn(identity, {
        executablePath: REAL_CLAUDE_PATH,
        executionContext: { kind: "TEST", signals: ["explicit"], detail: "explicit test" },
      }),
    ).toThrow(/Only an approved TEST_DOUBLE may be spawned/u);
  });

  it("REFUSES a TEST_DOUBLE identity that reaches a PRODUCTION context", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: testDouble.executablePath,
        executionContext: PRODUCTION,
      }),
    ).toThrow(/must never be recorded as paid scoring evidence/u);
  });

  it("REFUSES when the spawned path differs from the approved one", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, { executablePath: REAL_CLAUDE_PATH }),
    ).toThrow(/but the spawn would launch/u);
  });

  it("REFUSES a non-absolute spawn path", () => {
    expect(() => assertProviderIdentityForSpawn(testDouble, { executablePath: "claude" })).toThrow(
      /is not absolute/u,
    );
  });

  it("ACCEPTS the approved test double spawning exactly itself", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, { executablePath: testDouble.executablePath }),
    ).not.toThrow();
  });

  it("refuses a REAL identity outright when the live context is TEST", () => {
    const outcome = resolveRealProviderIdentity({
      executablePath: REAL_CLAUDE_PATH,
      context: detectExecutionContext(),
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("TEST_CONTEXT_REQUIRES_TEST_DOUBLE");
  });

  it("refuses a REAL identity for a binary that is actually a test double", async () => {
    expect(await observeTestDoubleMarker(FAKE_CLAUDE_CLI)).toBe(true);
    const outcome = resolveRealProviderIdentity({
      executablePath: FAKE_CLAUDE_CLI,
      context: PRODUCTION,
      markerObserved: true,
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("TEST_DOUBLE_IN_PRODUCTION_PATH");
  });

  it("does not see a marker in the real Claude executable, if one is installed", async () => {
    const located = await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      ["claude"],
      { encoding: "utf8", timeout: 15_000 },
    ).catch(() => null);
    const realPath = located?.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => path.isAbsolute(line));
    if (!realPath) return; // no first-party CLI installed here; nothing to assert
    // Reads bytes only. The real executable is never invoked by this suite.
    expect(await observeTestDoubleMarker(realPath)).toBe(false);
  }, 60_000);
});

describe("PROVIDER BOUNDARY: executePairedSlots cannot be reached without an identity", () => {
  const schedule = buildScoringSchedule({
    randomization: {
      seed: "isolation",
      taskOrder: ["alpha"],
      armOrder: { alpha: "NATIVE_FIRST" },
    },
    frozenTaskIds: ["alpha"],
    runsPerTask: 3,
  });
  const pair = pairSlots(schedule.slots)[0] as { native: RunSlot; maf: RunSlot };

  const authorizedDecision = (): ExecutionGateDecision => ({
    authorized: true,
    checks: [],
    failures: [],
    protocolFreezeAuthority: "GIT_TAG",
    protocolFrozen: true,
    knownSourceMetadataNote: "note",
    summary: "all gates passed",
  });

  it("refuses with NO authorization, before any slot is claimed", async () => {
    const store = new ScoringStateStore({ root: path.join(scratch, "no-auth") });
    await expect(
      executePairedSlots(
        {
          repoRoot,
          store,
          frozenTaskIds: ["alpha"],
          claudeCommand: FAKE_CLAUDE_CLI,
          runnerSha: null,
          campaignId: "camp",
          scheduleDigest: schedule.scheduleDigest,
          fixtureRootResolver: () => scratch,
          verifierLocate: () => null,
        },
        pair,
        {
          prompt: "x",
          expectedVerification: "y",
          authorization: undefined as never,
        },
      ),
    ).rejects.toThrow(/no provider authorization was supplied/u);
  });

  it("refuses a capability whose identity is REAL while running under test", async () => {
    const identity = (
      resolveRealProviderIdentity({
        executablePath: REAL_CLAUDE_PATH,
        context: { kind: "PRODUCTION", signals: [], detail: "synthetic" },
      }) as { approved: true; identity: ProviderIdentity }
    ).identity;
    const authorization = issueProviderAuthorization({
      decision: authorizedDecision(),
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      providerIdentity: identity,
    });
    expect(authorization).not.toBeNull();

    const store = new ScoringStateStore({ root: path.join(scratch, "real-identity") });
    await expect(
      executePairedSlots(
        {
          repoRoot,
          store,
          frozenTaskIds: ["alpha"],
          claudeCommand: REAL_CLAUDE_PATH,
          runnerSha: null,
          campaignId: "camp",
          scheduleDigest: schedule.scheduleDigest,
          fixtureRootResolver: () => scratch,
          verifierLocate: () => null,
        },
        pair,
        {
          prompt: "x",
          expectedVerification: "y",
          authorization: authorization as NonNullable<typeof authorization>,
        },
      ),
    ).rejects.toThrow(/Only an approved TEST_DOUBLE may be spawned/u);

    // Nothing was claimed and no intent was declared: the refusal precedes the state machine.
    expect(await countIntents(path.join(scratch, "real-identity"))).toBe(0);
  });
});

// ================================================ PROVE THE INCIDENT CANNOT RECUR

describe("INCIDENT REGRESSION: every incident precondition satisfied, ZERO real spawns", () => {
  it("reproduces the incident's structural conditions and refuses", async () => {
    // The incident's preconditions, reconstructed one by one.
    //
    //   REAL_RUNNER_TAG_PRESENT          the real repository holds maf-scoring-runner-v1
    //   TEST_BILLED_CONFIRMATION_PRESENT --confirm-billed-scoring is supplied
    //   ALL_FREEZE_GATES_SIMULATED_VALID the injected git world satisfies every freeze gate
    //   NO_APPROVED_TEST_PROVIDER        no test double is approved
    //
    // Expected: REAL_PROVIDER_SPAWNS = 0.
    const realTag = await execFileAsync("git", ["rev-list", "-n1", RUNNER_V1_TAG], {
      cwd: repoRoot,
      encoding: "utf8",
    }).catch(() => null);
    const REAL_RUNNER_TAG_PRESENT = realTag?.stdout.trim() === RUNNER_V1_SHA;
    expect(REAL_RUNNER_TAG_PRESENT).toBe(true);

    await initCampaign();

    // Freeze gates all VALID in the injected world, provider absent.
    const noProvider = await fixtureWithoutProvider();
    const withValidFreeze = await runCli(billed(noProvider));
    expect(withValidFreeze.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(withValidFreeze.stdout).not.toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(await countIntents(campaign)).toBe(0);

    // And the literal incident invocation: real repository, billed confirmation, nothing injected.
    const asIncident = await runCli(billed(null));
    expect(asIncident.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(asIncident.stdout).toMatch(/TEST_CONTEXT_WITHOUT_TEST_PROVIDER/u);
    expect(asIncident.stdout).toMatch(new RegExp(INCIDENT_TAG.replace(/-/gu, "-"), "u"));

    // REAL_PROVIDER_SPAWNS = 0.
    expect(await countIntents(campaign)).toBe(0);
  }, 300_000);

  it("then succeeds with an approved fake provider and fake Git -- fake spawns only", async () => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture));

    // APPROVED_FAKE_PROVIDER = true, FAKE_PROVIDER_SPAWNS > 0, REAL_PROVIDER_SPAWNS = 0.
    expect(result.stdout).toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    expect(result.stdout).toMatch(/pairs executed: 1/u);
    expect(await countIntents(campaign)).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
    expect(result.stdout.toLowerCase()).not.toMatch(/[\\/]claude\.exe/u);
  }, 300_000);
});

// =========================================================== RUNNER IDENTITY

describe("RUNNER v2 identity and Runner v1 prohibition", () => {
  it("scores under maf-scoring-runner-v2 and never under v1", () => {
    expect(RUNNER_TAG).toBe("maf-scoring-runner-v2");
    expect(RUNNER_VERSION).toBe("2.0.0");
    expect(RUNNER_V1_TAG).toBe("maf-scoring-runner-v1");
    expect(RUNNER_V1_STATUS).toBe("FROZEN_DEPRECATED_DO_NOT_SCORE");
    expect(RUNNER_TAG).not.toBe(RUNNER_V1_TAG);
  });

  it("records the incident identity without importing any incident observation", async () => {
    expect(INCIDENT_TAG).toBe("maf-scoring-incident-2026-09-03-v1");
    expect(INCIDENT_SHA).toBe("895797e0c58099c763e206b851ba144d287394db");

    // Mission Repair 10: the six accidental arm-runs must have NO path into campaign state,
    // aggregation, or any report. Proven structurally -- no scoring source reads the incident
    // artifact at all.
    const { readdir, readFile } = await import("node:fs/promises");
    const libDir = path.join(repoRoot, "evaluation", "experiments", "scoring", "lib");
    const sources = [
      ...(await readdir(libDir)).map((f) => path.join(libDir, f)),
      path.join(repoRoot, "evaluation", "experiments", "scoring", "run-scoring.ts"),
    ].filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/scoring-incident-2026-09-03\.json/u);
      expect(text).not.toMatch(/incidents[\\/]/u);
    }
  });

  it("leaves idempotency-key-race in its original frozen schedule position at N=3", async () => {
    // Mission Repair 11: the affected task is NOT moved, removed, replaced, pre-filled, deferred,
    // or marked invalid. It is an ordinary member of the frozen suite.
    const { readFile } = await import("node:fs/promises");
    const randomization = JSON.parse(
      await readFile(
        path.join(repoRoot, "evaluation", "experiments", "randomization.json"),
        "utf8",
      ),
    ) as { taskOrder: string[] };
    expect(randomization.taskOrder).toContain("idempotency-key-race");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        cli,
        "plan",
        "--json",
        "--task",
        "idempotency-key-race",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
    );
    const parsed = JSON.parse(stdout) as {
      schedule: { slots: Array<{ taskId: string; arm: string; replicate: number }> };
    };
    const slots = parsed.schedule.slots.filter((s) => s.taskId === "idempotency-key-race");
    expect(
      slots
        .filter((s) => s.arm === "NATIVE")
        .map((s) => s.replicate)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(
      slots
        .filter((s) => s.arm === "MAF")
        .map((s) => s.replicate)
        .sort(),
    ).toEqual([1, 2, 3]);
  }, 120_000);
});

// ============================================ STRUCTURAL RULE OVER THE TEST SUITE

describe("STRUCTURAL: no test confirms billing against real repository state", () => {
  it("every --confirm-billed-scoring in tests/ is accompanied by --test-fixture", async () => {
    // Mission Repair 4, enforced over the suite's source rather than trusted. This is the check
    // whose absence let the incident's test case exist at all.
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir(here)).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(path.join(here, file), "utf8");
      // Consider only ARGUMENT LISTS, not prose: an occurrence inside a quoted argument string.
      const usesBilled = /"--confirm-billed-scoring"/u.test(text);
      if (!usesBilled) continue;
      if (!/"--test-fixture"/u.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no test file references the removed conflated git-fixture seam", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    // This file is excluded because it necessarily contains the very string it searches for.
    const self = path.basename(fileURLToPath(import.meta.url));
    const files = (await readdir(here)).filter((f) => f.endsWith(".ts") && f !== self);
    // Assembled at runtime so the needle never appears literally in any scanned source.
    const needle = new RegExp(`"--${"git"}-fixture"`, "u");
    for (const file of files) {
      const text = await readFile(path.join(here, file), "utf8");
      expect(text).not.toMatch(needle);
    }
  });

  it("the approved fixture directory declares itself a test-controlled root", async () => {
    const outcome = await approveTestDoubleProvider({
      executablePath: FAKE_CLAUDE_CLI,
      context: detectExecutionContext(),
    });
    expect(outcome.approved).toBe(true);
    expect(
      (outcome as { approved: true; identity: ProviderIdentity }).identity.testDoubleRoot,
    ).toBe(path.join(here, "fixtures"));
  });

  it("a fixture root marker cannot be conjured by a marker alone", async () => {
    const dir = path.join(scratch, "marked-only");
    await mkdir(dir, { recursive: true });
    const exe = path.join(dir, "cli.mjs");
    await writeFile(exe, `// ${TEST_DOUBLE_MARKER}\n`, "utf8");
    const outcome = await approveTestDoubleProvider({
      executablePath: exe,
      context: detectExecutionContext(),
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("ROOT_MARKER_ABSENT");
  });
});
