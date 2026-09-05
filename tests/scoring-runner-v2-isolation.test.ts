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
// WHAT THE INDEPENDENT AUDIT ADDED
// --------------------------------
// The first v2 revision enforced that property with TypeScript brands and an ambient environment
// sniff. Both are erased or mutable at runtime, so this file now proves the runtime versions:
//
//   * a FORGED capability -- literal, spread, Object.assign clone, JSON round-trip -- is refused at
//     the boundary, for identity, authorization, gate decision AND execution context;
//   * TEST vs PRODUCTION is an explicitly constructed value, so a sanitized environment cannot
//     promote a test into a production run;
//   * test-double containment is decided on realpath-resolved paths, so a symlink or junction
//     cannot alias an outside file into a fixture root;
//   * the incident record is a mandatory frozen authority, proven local == remote == pinned commit.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveTestDoubleProvider,
  assertProviderIdentityForSpawn,
  isAuthenticProviderIdentity,
  observeTestDoubleMarker,
  resolveRealProviderIdentity,
  TEST_DOUBLE_MARKER,
  TEST_DOUBLE_ROOT_MARKER_FILE,
  type ProviderIdentity,
} from "../evaluation/experiments/scoring/lib/provider-identity";
import {
  createProductionExecutionContext,
  isAuthenticExecutionContext,
  observeAmbientTestSignals,
  type ExecutionContext,
} from "../evaluation/experiments/scoring/lib/execution-context";
import {
  createTestExecutionContext,
  createProductionExecutionContextForTest,
} from "../evaluation/experiments/scoring/lib/internal/test-support";
import {
  assertAuthorizedForPair,
  isAuthenticProviderAuthorization,
  issueProviderAuthorization,
  type ProviderAuthorization,
} from "../evaluation/experiments/scoring/lib/execution-gate";
import {
  evaluateCampaignGate,
  campaignBudgetDigest,
} from "../evaluation/experiments/scoring/lib/campaign-budget";
import {
  executePairedSlots,
  pairSlots,
} from "../evaluation/experiments/scoring/lib/participant-runner";
import { buildScoringSchedule, type RunSlot } from "../evaluation/experiments/scoring/lib/schedule";
import { ScoringStateStore } from "../evaluation/experiments/scoring/lib/state-store";
import { canonicalFrozenAuthorityDigest } from "../evaluation/experiments/scoring/lib/tag-verification";
import {
  INCIDENT_SHA,
  INCIDENT_TAG,
  RUNNER_TAG,
  RUNNER_V1_SHA,
  RUNNER_V1_STATUS,
  RUNNER_V1_TAG,
  RUNNER_VERSION,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import {
  approvedTestDouble,
  authenticDecision,
  authorizedCampaignGate,
  anotherTestExecutionContext,
  testExecutionContext,
  FAKE_CLAUDE_CLI,
} from "./helpers/test-double-provider";

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

/**
 * The same environment with EVERY test-harness signal stripped.
 *
 * This is the audit's Repair 3 case: a child that looks, to any ambient sniff, like an ordinary
 * production invocation. Under the old ambient classification it WOULD have been one. Now the
 * classification comes from the seam, so stripping these changes nothing.
 */
const sanitizedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = simulationEnv(extra);
  for (const key of Object.keys(env)) {
    if (/^(VITEST|JEST|NODE_TEST|npm_lifecycle)/u.test(key)) delete env[key];
  }
  delete env.NODE_ENV;
  delete env.MAF_SCORING_EXECUTION_CONTEXT;
  return env;
};

// ---------------------------------------------------------------- subprocess harness

const runCli = async (
  args: string[],
  env: Record<string, string> = {},
  envBuilder: (extra: Record<string, string>) => NodeJS.ProcessEnv = simulationEnv,
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
        env: envBuilder({ MAF_SIM_HEAD: "a".repeat(40), ...env }),
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

const approvedFixtureUrl = (): string =>
  new URL(`file:///${approvedFixture.replace(/\\/gu, "/")}`).href;

/**
 * Writes a test-seam module that keeps the approved fixture's VALID simulated git state and its
 * authentic TEST execution context, but substitutes a different provider. Every freeze gate
 * therefore still passes, isolating the provider question -- which is exactly the shape of the
 * incident.
 */
const fixtureWithProvider = async (name: string, providerExpression: string): Promise<string> => {
  const file = path.join(scratch, `${name}.mjs`);
  await writeFile(
    file,
    `export { git, resolve, checkAuth, participantFixtureRoot, executionContext } from ${JSON.stringify(approvedFixtureUrl())};\n` +
      `export const testDoubleProviderPath = ${providerExpression};\n`,
    "utf8",
  );
  return file;
};

/** A fixture module deliberately missing the provider seam entirely. */
const fixtureWithoutProvider = async (): Promise<string> => {
  const file = path.join(scratch, "no-provider.mjs");
  await writeFile(
    file,
    `export { git, resolve, checkAuth, participantFixtureRoot, executionContext } from ${JSON.stringify(approvedFixtureUrl())};\n`,
    "utf8",
  );
  return file;
};

/** A fixture whose execution context is substituted by the given expression. */
const fixtureWithContext = async (name: string, contextExpression: string): Promise<string> => {
  const file = path.join(scratch, `${name}.mjs`);
  await writeFile(
    file,
    `import { executionContext as authentic } from ${JSON.stringify(approvedFixtureUrl())};\n` +
      `export { git, resolve, checkAuth, participantFixtureRoot, testDoubleProviderPath } from ${JSON.stringify(approvedFixtureUrl())};\n` +
      `export const executionContext = ${contextExpression};\n`,
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
      /NOT_A_FILE|UNRESOLVABLE_PATH/u,
    );
  }, 300_000);

  // ------------------------------------------------- forged execution contexts (audit Repair 4)

  it("a hand-written { kind: 'TEST' } context -> refuse", async () => {
    // The audit's exact finding, at the CLI seam: a plain object that merely CLAIMS to be a TEST
    // context. It is refused because authenticity is a runtime registration, not a shape.
    await expectRefusal(
      await fixtureWithContext(
        "forged-context",
        '{ kind: "TEST", origin: "forged", createdAt: "", ambient: { signals: [], looksLikeTest: true, detail: "" }, signals: [], detail: "forged" }',
      ),
      /TEST_SEAM_CONTEXT_NOT_AUTHENTIC/u,
    );
  }, 300_000);

  it("a spread clone of the authentic context -> refuse", async () => {
    await expectRefusal(
      await fixtureWithContext("spread-context", "{ ...authentic }"),
      /TEST_SEAM_CONTEXT_NOT_AUTHENTIC/u,
    );
  }, 300_000);

  it("a JSON round-trip of the authentic context -> refuse", async () => {
    await expectRefusal(
      await fixtureWithContext("json-context", "JSON.parse(JSON.stringify(authentic))"),
      /TEST_SEAM_CONTEXT_NOT_AUTHENTIC/u,
    );
  }, 300_000);

  it("an Object.assign clone of the authentic context -> refuse", async () => {
    await expectRefusal(
      await fixtureWithContext("assign-context", "Object.assign({}, authentic)"),
      /TEST_SEAM_CONTEXT_NOT_AUTHENTIC/u,
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

describe("MATRIX: a sanitized environment cannot promote a TEST run (audit Repair 3)", () => {
  it("explicit TEST context survives an environment with every harness signal stripped", async () => {
    // Under the previous ambient classification this child would have been PRODUCTION: nothing in
    // its environment says "test". The classification now comes from the seam, so it stays TEST and
    // still admits only the approved double.
    await initCampaign();
    const result = await runCli(billed(approvedFixture), {}, sanitizedEnv);
    expect(result.stdout).toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
    expect(await countIntents(campaign)).toBe(2);
  }, 300_000);

  it("and the CLI reports the context as constructed rather than detected", async () => {
    const result = await runCli(["validate"], {}, sanitizedEnv);
    expect(result.stdout).toMatch(/execution context: PRODUCTION/u);
    expect(result.stdout).toMatch(/explicitly constructed by run-scoring\.ts/u);
  }, 120_000);

  it("there is no --test-mode flag that could convert production into test", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(cli, "utf8");
    // Look for an actual FLAG, not for prose: the CLI's own documentation names `--test-mode` as
    // the thing that deliberately does not exist, so a bare substring search would match the
    // comment explaining its absence.
    expect(source).not.toMatch(/flag\("test-mode"\)|value\("test-mode"\)|"--test-mode"/u);
    // Exactly one execution-context construction, and it is the production one.
    expect(source).toMatch(/createProductionExecutionContext\(/u);
    expect(source).not.toMatch(/createTestExecutionContext/u);
    expect(source).not.toMatch(/__INTERNAL_/u);
  });
});

describe("MATRIX: the incident record is a mandatory frozen authority (audit Repair 5)", () => {
  const expectIncidentRefusal = async (variant: string) => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture), { MAF_SIM_VARIANT: variant });
    expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(result.stdout).toMatch(/\[FAIL\] INCIDENT_FROZEN/u);
    expect(result.stdout).not.toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(await countIntents(campaign)).toBe(0);
  };

  it("incident tag absent entirely -> refuse", async () => {
    await expectIncidentRefusal("INCIDENT_TAG_ABSENT");
  }, 300_000);

  it("incident tag missing LOCALLY (remote only) -> refuse", async () => {
    await expectIncidentRefusal("INCIDENT_REMOTE_ONLY");
  }, 300_000);

  it("incident tag missing on the REMOTE (local only) -> refuse", async () => {
    await expectIncidentRefusal("INCIDENT_LOCAL_ONLY");
  }, 300_000);

  it("incident tag peeling to the wrong LOCAL commit -> refuse", async () => {
    await expectIncidentRefusal("INCIDENT_WRONG_LOCAL_SHA");
  }, 300_000);

  it("incident tag peeling to the wrong REMOTE commit -> refuse", async () => {
    await expectIncidentRefusal("INCIDENT_WRONG_REMOTE_SHA");
  }, 300_000);

  it("correct local AND remote peeled incident commit -> that gate passes", async () => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture));
    expect(result.stdout).toMatch(/\[PASS\] INCIDENT_FROZEN/u);
    expect(result.stdout).toMatch(
      new RegExp(`${INCIDENT_TAG} verified local == remote == ${INCIDENT_SHA}`, "u"),
    );
  }, 300_000);

  it("the real repository's incident tag peels to the pinned commit, local and remote", async () => {
    const local = await execFileAsync("git", ["rev-parse", `refs/tags/${INCIDENT_TAG}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(local.stdout.trim()).toBe(INCIDENT_SHA);
    const remote = await execFileAsync(
      "git",
      ["ls-remote", "origin", `refs/tags/${INCIDENT_TAG}`, `refs/tags/${INCIDENT_TAG}^{}`],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    const peeled = remote.stdout
      .split(/\r?\n/u)
      .find((line) => line.trim().endsWith(`refs/tags/${INCIDENT_TAG}^{}`));
    expect(peeled?.split(/\s+/u)[0]).toBe(INCIDENT_SHA);
  }, 120_000);

  it("a --skip-remote incident check is reported as NOT proven", async () => {
    // Mission: `skipRemote` must refuse rather than quietly narrow what was proven.
    const result = await runCli(["validate", "--skip-remote"]);
    expect(result.stdout).toMatch(/INCIDENT_FROZEN: the remote was not consulted/u);
  }, 120_000);
});

describe("MATRIX: tag state cannot influence test safety", () => {
  // The heart of the isolation property. Runner v1's tag IS present on the real machine, and v2's
  // will be one day; neither may change what a test can reach.
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
    testDouble = await approvedTestDouble(FAKE_CLAUDE_CLI, testExecutionContext);
  });

  /** An AUTHENTIC production context. Minting one grants nothing: the live environment still says TEST. */
  const productionContext = (): ExecutionContext =>
    createProductionExecutionContextForTest("isolation-test");

  it("refuses when no identity is supplied at all", () => {
    expect(() =>
      assertProviderIdentityForSpawn(undefined, {
        executablePath: FAKE_CLAUDE_CLI,
        executionContext: testExecutionContext,
      }),
    ).toThrow(/no provider identity was supplied/u);
  });

  it("REFUSES a PRODUCTION context whose environment plainly shows a test harness", () => {
    // The audit's Repair 3, at the boundary. Ambient environment cannot GRANT production status, so
    // the disagreement fails closed rather than resolving in favour of the claim.
    expect(observeAmbientTestSignals().looksLikeTest).toBe(true);
    const production = productionContext();
    const identity = (
      resolveRealProviderIdentity({
        executablePath: REAL_CLAUDE_PATH,
        context: production,
        // A spotless environment at MINT time, so the refusal below comes from the live check.
        environment: {},
      }) as { approved: true; identity: ProviderIdentity }
    ).identity;

    expect(() =>
      assertProviderIdentityForSpawn(identity, {
        executablePath: REAL_CLAUDE_PATH,
        executionContext: production,
      }),
    ).toThrow(/environment plainly shows a test harness/u);
  });

  it("REFUSES a REAL_PROVIDER identity presented under a TEST context", () => {
    const production = productionContext();
    const identity = (
      resolveRealProviderIdentity({
        executablePath: REAL_CLAUDE_PATH,
        context: production,
        environment: {},
      }) as { approved: true; identity: ProviderIdentity }
    ).identity;
    expect(identity.kind).toBe("REAL_PROVIDER_EXECUTION");

    // Presented under the TEST context it was NOT minted in: refused on context binding first.
    expect(() =>
      assertProviderIdentityForSpawn(identity, {
        executablePath: REAL_CLAUDE_PATH,
        executionContext: testExecutionContext,
      }),
    ).toThrow(/established in a different execution context/u);
  });

  it("REFUSES a TEST_DOUBLE identity that reaches a PRODUCTION context", () => {
    // Minted in TEST, presented in PRODUCTION. Under vitest the ambient contradiction fires first --
    // which is the STRONGER refusal, and the one that matters: a PRODUCTION claim made inside a
    // visible test harness never gets as far as being asked which provider it names.
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: testDouble.executablePath,
        executionContext: productionContext(),
      }),
    ).toThrow(/environment plainly shows a test harness/u);
  });

  it("REFUSES a TEST_DOUBLE in a PRODUCTION context even with a spotless environment", () => {
    // The same refusal with the ambient check satisfied, so the interlock itself is what speaks:
    // simulated observations must never be recorded as paid scoring evidence.
    const production = createProductionExecutionContext("spotless", {});
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: testDouble.executablePath,
        executionContext: production,
        environment: {},
      }),
    ).toThrow(/different execution context/u);
  });

  it("REFUSES an identity minted in a DIFFERENT authentic TEST context", () => {
    const other = anotherTestExecutionContext("isolation-other");
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: testDouble.executablePath,
        executionContext: other,
      }),
    ).toThrow(/different execution context/u);
  });

  it("REFUSES when the spawned path differs from the approved one", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: REAL_CLAUDE_PATH,
        executionContext: testExecutionContext,
      }),
    ).toThrow(/but the spawn would launch/u);
  });

  it("REFUSES a non-absolute spawn path", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: "claude",
        executionContext: testExecutionContext,
      }),
    ).toThrow(/is not absolute/u);
  });

  it("ACCEPTS the approved test double spawning exactly itself", () => {
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: testDouble.executablePath,
        executionContext: testExecutionContext,
      }),
    ).not.toThrow();
  });

  it("refuses a REAL identity outright when the context is TEST", () => {
    const outcome = resolveRealProviderIdentity({
      executablePath: REAL_CLAUDE_PATH,
      context: testExecutionContext,
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("TEST_CONTEXT_REQUIRES_TEST_DOUBLE");
  });

  it("refuses a REAL identity for a binary that is actually a test double", async () => {
    expect(await observeTestDoubleMarker(FAKE_CLAUDE_CLI)).toBe(true);
    const outcome = resolveRealProviderIdentity({
      executablePath: FAKE_CLAUDE_CLI,
      context: productionContext(),
      markerObserved: true,
      environment: {},
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

// ==================================== FORGERY: runtime authenticity (audit Repairs 1, 2, 4)

describe("FORGERY: a forged ProviderIdentity is refused at the spawn boundary", () => {
  let testDouble: ProviderIdentity;
  beforeAll(async () => {
    testDouble = await approvedTestDouble(FAKE_CLAUDE_CLI, testExecutionContext);
  });

  const spawn = (identity: ProviderIdentity): void =>
    assertProviderIdentityForSpawn(identity, {
      executablePath: FAKE_CLAUDE_CLI,
      executionContext: testExecutionContext,
    });

  it("a hand-created plain object -> REFUSE", () => {
    // Structurally identical to a real identity, and a `declare const BRAND` cannot tell the
    // difference at runtime. This is the audit's finding, reproduced and now refused.
    const forged = {
      kind: "TEST_DOUBLE_PROVIDER_EXECUTION",
      executablePath: FAKE_CLAUDE_CLI,
      resolvedExecutablePath: FAKE_CLAUDE_CLI,
      testDoubleRoot: path.join(here, "fixtures"),
      context: testExecutionContext,
      detail: "forged",
    } as unknown as ProviderIdentity;
    expect(isAuthenticProviderIdentity(forged)).toBe(false);
    expect(() => spawn(forged)).toThrow(/not created by the provider-identity factories/u);
  });

  it("an object spread of a VALID identity -> REFUSE", () => {
    const clone = { ...testDouble } as ProviderIdentity;
    expect(isAuthenticProviderIdentity(clone)).toBe(false);
    expect(() => spawn(clone)).toThrow(/not created by the provider-identity factories/u);
  });

  it("an Object.assign clone of a VALID identity -> REFUSE", () => {
    const clone = Object.assign({}, testDouble) as ProviderIdentity;
    expect(isAuthenticProviderIdentity(clone)).toBe(false);
    expect(() => spawn(clone)).toThrow(/not created by the provider-identity factories/u);
  });

  it("a JSON serialize/deserialize round-trip -> REFUSE", () => {
    const roundTripped = JSON.parse(JSON.stringify(testDouble)) as ProviderIdentity;
    expect(isAuthenticProviderIdentity(roundTripped)).toBe(false);
    expect(() => spawn(roundTripped)).toThrow(/not created by the provider-identity factories/u);
  });

  it("a structurally identical object built field by field -> REFUSE", () => {
    const rebuilt = Object.freeze({
      kind: testDouble.kind,
      executablePath: testDouble.executablePath,
      resolvedExecutablePath: testDouble.resolvedExecutablePath,
      testDoubleRoot: testDouble.testDoubleRoot,
      context: testDouble.context,
      detail: testDouble.detail,
    }) as unknown as ProviderIdentity;
    expect(isAuthenticProviderIdentity(rebuilt)).toBe(false);
    expect(() => spawn(rebuilt)).toThrow(/not created by the provider-identity factories/u);
  });

  it("only the exact object the factory built is accepted", () => {
    expect(isAuthenticProviderIdentity(testDouble)).toBe(true);
    expect(() => spawn(testDouble)).not.toThrow();
  });

  it("no exported primitive registers a caller-supplied object", async () => {
    // The registry must not be reachable. If any export could bless an arbitrary object, every
    // refusal above would be a formality.
    const module = (await import(
      "../evaluation/experiments/scoring/lib/provider-identity"
    )) as Record<string, unknown>;
    // Names that would indicate a primitive taking a caller-built object and blessing it. The
    // read-only predicates (`isAuthentic*`) and the marker CONSTANTS are fine -- reading membership
    // proves nothing about who can join.
    const suspicious = Object.keys(module).filter((name) =>
      /^(register|bless|trust|add|mark)[A-Z]/u.test(name),
    );
    expect(suspicious).toEqual([]);
    // And the registry itself is never handed out under any name.
    for (const value of Object.values(module)) {
      expect(value instanceof WeakSet).toBe(false);
      expect(value instanceof Set).toBe(false);
    }
  });
});

describe("FORGERY: a forged execution context is refused", () => {
  const forgedContext = { kind: "TEST", origin: "forged", signals: [], detail: "forged" };

  it("a plain { kind: 'TEST' } object is not authentic", () => {
    expect(isAuthenticExecutionContext(forgedContext)).toBe(false);
    expect(isAuthenticExecutionContext({ kind: "TEST" })).toBe(false);
  });

  it("a spread clone and a JSON round-trip of a REAL context are not authentic", () => {
    expect(isAuthenticExecutionContext({ ...testExecutionContext })).toBe(false);
    expect(isAuthenticExecutionContext(JSON.parse(JSON.stringify(testExecutionContext)))).toBe(
      false,
    );
    expect(isAuthenticExecutionContext(Object.assign({}, testExecutionContext))).toBe(false);
  });

  it("the spawn boundary refuses a forged context outright", async () => {
    const testDouble = await approvedTestDouble(FAKE_CLAUDE_CLI, testExecutionContext);
    expect(() =>
      assertProviderIdentityForSpawn(testDouble, {
        executablePath: FAKE_CLAUDE_CLI,
        executionContext: forgedContext,
      }),
    ).toThrow(/did not construct/u);
  });

  it("test-double approval refuses a forged context", async () => {
    const outcome = await approveTestDoubleProvider({
      executablePath: FAKE_CLAUDE_CLI,
      context: forgedContext,
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("CONTEXT_NOT_AUTHENTIC");
  });

  it("real-provider resolution refuses a forged context", () => {
    const outcome = resolveRealProviderIdentity({
      executablePath: REAL_CLAUDE_PATH,
      context: { kind: "PRODUCTION" },
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("CONTEXT_NOT_AUTHENTIC");
  });

  it("an authentic PRODUCTION context is still available to production code", () => {
    // The production factory must keep working -- the repair restricts WHO can make a TEST context,
    // not whether production can classify itself.
    expect(isAuthenticExecutionContext(createProductionExecutionContext("unit"))).toBe(true);
    expect(isAuthenticExecutionContext(createTestExecutionContext("unit"))).toBe(true);
  });
});

describe("FORGERY: a forged ProviderAuthorization is refused", () => {
  const schedule = buildScoringSchedule({
    randomization: { seed: "forge", taskOrder: ["alpha"], armOrder: { alpha: "NATIVE_FIRST" } },
    frozenTaskIds: ["alpha"],
    runsPerTask: 3,
  });
  const pair = pairSlots(schedule.slots)[0] as { native: RunSlot; maf: RunSlot };

  let testDouble: ProviderIdentity;
  let real: ProviderAuthorization;
  let boundaryContext: {
    campaignId: string;
    scheduleDigest: string;
    nativeSlotDigest: string;
    mafSlotDigest: string;
    executablePath: string;
    executionContext: ExecutionContext;
  };

  beforeAll(async () => {
    testDouble = await approvedTestDouble(FAKE_CLAUDE_CLI, testExecutionContext);
    real = issueProviderAuthorization({
      decision: authenticDecision(testDouble),
      campaignGate: authorizedCampaignGate(),
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      providerIdentity: testDouble,
      executionContext: testExecutionContext,
    }) as ProviderAuthorization;
    boundaryContext = {
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      executablePath: FAKE_CLAUDE_CLI,
      executionContext: testExecutionContext,
    };
  });

  it("mints a real capability when every precondition holds", () => {
    expect(isAuthenticProviderAuthorization(real)).toBe(true);
    expect(() => assertAuthorizedForPair(real, boundaryContext)).not.toThrow();
  });

  it("a hand-constructed authorization -> REFUSE", () => {
    const forged = {
      decision: real.decision,
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      executablePath: FAKE_CLAUDE_CLI,
      providerIdentity: testDouble,
      executionContext: testExecutionContext,
      freezeAuthorityDigest: real.freezeAuthorityDigest,
      budgetDigest: real.budgetDigest,
      issuedAt: new Date().toISOString(),
    } as unknown as ProviderAuthorization;
    expect(isAuthenticProviderAuthorization(forged)).toBe(false);
    expect(() => assertAuthorizedForPair(forged, boundaryContext)).toThrow(
      /not minted by issueProviderAuthorization/u,
    );
  });

  it("a spread clone -> REFUSE", () => {
    const clone = { ...real } as ProviderAuthorization;
    expect(() => assertAuthorizedForPair(clone, boundaryContext)).toThrow(
      /not minted by issueProviderAuthorization/u,
    );
  });

  it("an Object.assign clone -> REFUSE", () => {
    const clone = Object.assign({}, real) as ProviderAuthorization;
    expect(() => assertAuthorizedForPair(clone, boundaryContext)).toThrow(
      /not minted by issueProviderAuthorization/u,
    );
  });

  it("a JSON round-trip -> REFUSE", () => {
    const roundTripped = JSON.parse(JSON.stringify(real)) as ProviderAuthorization;
    expect(() => assertAuthorizedForPair(roundTripped, boundaryContext)).toThrow(
      /not minted by issueProviderAuthorization/u,
    );
  });

  it("a FORGED gate decision cannot mint a capability at all", () => {
    // The chain must not be startable from an object that no gate produced.
    const forgedDecision = {
      authorized: true,
      checks: [],
      failures: [],
      protocolFreezeAuthority: "GIT_TAG",
      protocolFrozen: true,
      knownSourceMetadataNote: "forged",
      executionContext: testExecutionContext,
      providerIdentity: testDouble,
      freezeAuthorityDigest: canonicalFrozenAuthorityDigest(),
      incidentFrozen: true,
      summary: "forged",
    } as never;
    expect(
      issueProviderAuthorization({
        decision: forgedDecision,
        campaignGate: authorizedCampaignGate(),
        campaignId: "camp",
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: pair.native.slotDigest,
        mafSlotDigest: pair.maf.slotDigest,
        providerIdentity: testDouble,
        executionContext: testExecutionContext,
      }),
    ).toBeNull();
  });

  it("a FORGED provider identity cannot mint a capability", () => {
    expect(
      issueProviderAuthorization({
        decision: authenticDecision(testDouble),
        campaignGate: authorizedCampaignGate(),
        campaignId: "camp",
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: pair.native.slotDigest,
        mafSlotDigest: pair.maf.slotDigest,
        providerIdentity: { ...testDouble } as ProviderIdentity,
        executionContext: testExecutionContext,
      }),
    ).toBeNull();
  });

  it("a capability bound to a DIFFERENT campaign -> REFUSE", () => {
    expect(() =>
      assertAuthorizedForPair(real, { ...boundaryContext, campaignId: "other-campaign" }),
    ).toThrow(/campaign/u);
  });

  it("a capability bound to a DIFFERENT pair -> REFUSE", () => {
    expect(() =>
      assertAuthorizedForPair(real, { ...boundaryContext, nativeSlotDigest: "different" }),
    ).toThrow(/NATIVE slot digest differs/u);
  });

  it("a capability bound to a DIFFERENT executable -> REFUSE", () => {
    expect(() =>
      assertAuthorizedForPair(real, { ...boundaryContext, executablePath: REAL_CLAUDE_PATH }),
    ).toThrow(/but the spawn would launch|issued against executable/u);
  });

  it("a capability bound to DIFFERENT freeze identities -> REFUSE", () => {
    expect(() =>
      assertAuthorizedForPair(real, {
        ...boundaryContext,
        freezeAuthorityDigest: "a-different-frozen-world",
      }),
    ).toThrow(/frozen-authority digest differs/u);
  });

  it("a capability bound to a DIFFERENT budget state -> REFUSE", () => {
    // The exact replay the audit named: a capability minted with ample headroom, presented after
    // the campaign has spent down.
    const spentDown = campaignBudgetDigest(
      evaluateCampaignGate({ states: [], ceilingUsd: 40, perRunCeilingUsd: 8 }),
    );
    expect(spentDown).not.toBe(real.budgetDigest);
    expect(() =>
      assertAuthorizedForPair(real, { ...boundaryContext, budgetDigest: spentDown }),
    ).toThrow(/budget-state digest differs/u);
  });

  it("a capability bound to a DIFFERENT execution context -> REFUSE", () => {
    const other = anotherTestExecutionContext("forgery-other");
    expect(() =>
      assertAuthorizedForPair(real, { ...boundaryContext, executionContext: other }),
    ).toThrow(/minted in a different execution context/u);
  });

  it("a capability presented with a FORGED execution context -> REFUSE", () => {
    expect(() =>
      assertAuthorizedForPair(real, {
        ...boundaryContext,
        executionContext: { kind: "TEST" },
      }),
    ).toThrow(/did not construct/u);
  });

  it("a capability minted against an UNAUTHORIZED budget gate is never issued", () => {
    expect(
      issueProviderAuthorization({
        decision: authenticDecision(testDouble),
        campaignGate: evaluateCampaignGate({
          states: [],
          ceilingUsd: 10, // less than one pair's $16 exposure
          perRunCeilingUsd: 8,
        }),
        campaignId: "camp",
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: pair.native.slotDigest,
        mafSlotDigest: pair.maf.slotDigest,
        providerIdentity: testDouble,
        executionContext: testExecutionContext,
      }),
    ).toBeNull();
  });
});

// ============================================ REALPATH CONTAINMENT (audit Repair 7)

describe("REALPATH: test-double containment is decided on canonical paths", () => {
  /** Builds a declared fixture root inside the scratch directory. */
  const makeRoot = async (name: string): Promise<string> => {
    const root = path.join(scratch, name);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, TEST_DOUBLE_ROOT_MARKER_FILE), "root\n", "utf8");
    return root;
  };

  const writeDouble = async (file: string): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `// ${TEST_DOUBLE_MARKER}\nprocess.exit(0);\n`, "utf8");
    return file;
  };

  const approve = (executablePath: string) =>
    approveTestDoubleProvider({ executablePath, context: testExecutionContext });

  it("ALLOWS a real file genuinely inside the declared root", async () => {
    const root = await makeRoot("real-root");
    const exe = await writeDouble(path.join(root, "cli.mjs"));
    const outcome = await approve(exe);
    expect(outcome.approved).toBe(true);
  });

  it("ALLOWS a nested legitimate fake executable", async () => {
    const root = await makeRoot("nested-root");
    const exe = await writeDouble(path.join(root, "a", "b", "cli.mjs"));
    const outcome = await approve(exe);
    expect(outcome.approved).toBe(true);
    const identity = (outcome as { approved: true; identity: ProviderIdentity }).identity;
    // The recorded root is the canonical MARKER directory, not the executable's own directory --
    // so a legitimately nested double is approved while its containment stays anchored to the
    // declared root.
    const { realpath } = await import("node:fs/promises");
    expect(identity.testDoubleRoot?.toLowerCase()).toBe((await realpath(root)).toLowerCase());
    expect(identity.resolvedExecutablePath.toLowerCase()).toBe((await realpath(exe)).toLowerCase());
  });

  it("REFUSES a relative-escape path", async () => {
    const root = await makeRoot("rel-root");
    await writeDouble(path.join(root, "cli.mjs"));
    const outside = await writeDouble(path.join(scratch, "outside-cli.mjs"));
    // A path that traverses THROUGH the declared root but lands outside it.
    const escaping = path.join(root, "..", path.basename(outside));
    const outcome = await approve(escaping);
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("ROOT_MARKER_ABSENT");
  });

  it("REFUSES a SYMLINK from inside the root to a file outside it", async () => {
    const root = await makeRoot("symlink-root");
    const outside = await writeDouble(path.join(scratch, "outside", "evil-cli.mjs"));
    const link = path.join(root, "looks-legit.mjs");
    try {
      await symlink(outside, link, "file");
    } catch {
      // Windows without Developer Mode or elevation cannot create FILE symlinks (EPERM). The
      // junction case below is the escape that matters on that platform, and it always runs.
      return;
    }
    const outcome = await approve(link);
    expect(outcome.approved).toBe(false);
    // Resolved first, so the walk starts OUTSIDE the root and finds no marker.
    expect((outcome as { reason: string }).reason).toBe("ROOT_MARKER_ABSENT");
  });

  it("REFUSES a JUNCTION from inside the root to a tree outside it", async () => {
    // The realistic Windows escape: a junction needs no elevation and no Developer Mode, so it is
    // the alias an ordinary process can actually create. This case must genuinely RUN on Windows --
    // see the platform-capability guard below, which fails if it ever silently stops doing so.
    const root = await makeRoot("junction-root");
    const outsideDir = path.join(scratch, "outside-tree");
    await writeDouble(path.join(outsideDir, "evil-cli.mjs"));
    const linkDir = path.join(root, "linked");
    await symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");

    const aliased = path.join(linkDir, "evil-cli.mjs");
    const outcome = await approve(aliased);
    expect(outcome.approved).toBe(false);
    // Resolved first, so the walk starts OUTSIDE the root and finds no marker.
    expect((outcome as { reason: string }).reason).toBe("ROOT_MARKER_ABSENT");
  });

  it("proves at least one link-based escape was actually exercised on this platform", async () => {
    // Guard against a false negative. Both link tests above would pass vacuously if the platform
    // refused to create the link, so this asserts that a directory link -- the escape that needs no
    // elevation anywhere -- really can be made here. If this fails, the escape coverage above is
    // not evidence and must be investigated rather than assumed.
    const probeRoot = path.join(scratch, "link-capability");
    const target = path.join(probeRoot, "target");
    await mkdir(target, { recursive: true });
    const link = path.join(probeRoot, "link");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const { realpath } = await import("node:fs/promises");
    expect((await realpath(link)).toLowerCase()).toBe((await realpath(target)).toLowerCase());
  });

  it("REFUSES a link whose canonical target names the real Claude CLI", async () => {
    const root = await makeRoot("alias-root");
    const realish = path.join(scratch, "bin", "claude.exe");
    await writeDouble(realish);
    const link = path.join(root, "harmless-name.mjs");
    try {
      await symlink(realish, link, "file");
    } catch {
      return;
    }
    const outcome = await approve(link);
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("REAL_CLAUDE_EXECUTABLE");
  });

  it("reads the marker from the RESOLVED file, so a marker in the NAME proves nothing", async () => {
    const root = await makeRoot("name-marker-root");
    const exe = path.join(root, `${TEST_DOUBLE_MARKER}.mjs`);
    await mkdir(path.dirname(exe), { recursive: true });
    await writeFile(exe, "process.exit(0);\n", "utf8"); // marker in the filename ONLY
    const outcome = await approve(exe);
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("MARKER_ABSENT");
  });

  it("REFUSES a directory presented as the executable", async () => {
    const root = await makeRoot("dir-root");
    const dir = path.join(root, "not-a-file");
    await mkdir(dir, { recursive: true });
    const outcome = await approve(dir);
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("NOT_A_FILE");
  });
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
          executionContext: testExecutionContext,
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
    // A capability minted in an authentic PRODUCTION context, presented under the TEST context the
    // runner is executing in. Both the context binding and the interlock refuse it.
    const production = createProductionExecutionContextForTest("isolation-real");
    const identity = (
      resolveRealProviderIdentity({
        executablePath: REAL_CLAUDE_PATH,
        context: production,
        environment: {},
      }) as { approved: true; identity: ProviderIdentity }
    ).identity;
    const authorization = issueProviderAuthorization({
      decision: authenticDecision(identity, production),
      campaignGate: authorizedCampaignGate(),
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      providerIdentity: identity,
      executionContext: production,
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
          executionContext: testExecutionContext,
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
    ).rejects.toThrow(/minted in a different execution context/u);

    // Nothing was claimed and no intent was declared: the refusal precedes the state machine.
    expect(await countIntents(path.join(scratch, "real-identity"))).toBe(0);
  });
});

// ================================================ PROVE THE INCIDENT CANNOT RECUR

describe("INCIDENT REGRESSION: every incident precondition satisfied, ZERO real spawns", () => {
  it("CASE A: freeze gates valid, billed confirmed, TEST context, NO approved double -> 0 spawns", async () => {
    // The incident's preconditions, reconstructed one by one.
    //
    //   REAL_RUNNER_TAG_PRESENT          the real repository holds maf-scoring-runner-v1
    //   TEST_BILLED_CONFIRMATION_PRESENT --confirm-billed-scoring is supplied
    //   ALL_FREEZE_GATES_SIMULATED_VALID the injected git world satisfies every freeze gate
    //   NO_APPROVED_TEST_PROVIDER        no test double is approved
    //
    // Expected: PROVIDER_SPAWNS = 0.
    const realTag = await execFileAsync("git", ["rev-list", "-n1", RUNNER_V1_TAG], {
      cwd: repoRoot,
      encoding: "utf8",
    }).catch(() => null);
    expect(realTag?.stdout.trim()).toBe(RUNNER_V1_SHA);

    await initCampaign();

    const noProvider = await fixtureWithoutProvider();
    const withValidFreeze = await runCli(billed(noProvider));
    expect(withValidFreeze.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(withValidFreeze.stdout).not.toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(await countIntents(campaign)).toBe(0);

    // And the literal incident invocation: real repository, billed confirmation, nothing injected.
    const asIncident = await runCli(billed(null));
    expect(asIncident.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(asIncident.stdout).toMatch(/TEST_CONTEXT_WITHOUT_TEST_PROVIDER/u);
    expect(asIncident.stdout).toMatch(new RegExp(INCIDENT_TAG, "u"));

    expect(await countIntents(campaign)).toBe(0);
  }, 300_000);

  it("CASE B: same, but an approved runtime-authentic TEST_DOUBLE exists -> fake spawns only", async () => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture));

    expect(result.stdout).toMatch(/SCORING_EXECUTION_AUTHORIZED/u);
    expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    expect(result.stdout).toMatch(/pairs executed: 1/u);
    // FAKE_PROVIDER_SPAWNS > 0, REAL_PROVIDER_SPAWNS = 0.
    expect(await countIntents(campaign)).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
    expect(result.stdout.toLowerCase()).not.toMatch(/[\\/]claude\.exe/u);
  }, 300_000);

  it("CASE C: forged provider identity -> 0 spawns", async () => {
    await initCampaign();
    // A fixture naming a file that cannot be approved is the CLI-level equivalent of a forged
    // identity: the mint refuses, so no capability exists and nothing spawns.
    const result = await runCli(
      billed(await fixtureWithProvider("case-c", JSON.stringify(REAL_CLAUDE_PATH))),
    );
    expect(result.stdout).toMatch(/SCORING_EXECUTION_REFUSED/u);
    expect(result.stdout).toMatch(/\[FAIL\] PROVIDER_IDENTITY/u);
    expect(await countIntents(campaign)).toBe(0);
  }, 300_000);

  it("CASE D: forged authorization -> 0 spawns", async () => {
    // In-process, because a forged capability is not expressible through the CLI at all.
    const schedule = buildScoringSchedule({
      randomization: { seed: "d", taskOrder: ["alpha"], armOrder: { alpha: "NATIVE_FIRST" } },
      frozenTaskIds: ["alpha"],
      runsPerTask: 3,
    });
    const pair = pairSlots(schedule.slots)[0] as { native: RunSlot; maf: RunSlot };
    const testDouble = await approvedTestDouble(FAKE_CLAUDE_CLI, testExecutionContext);
    const real = issueProviderAuthorization({
      decision: authenticDecision(testDouble),
      campaignGate: authorizedCampaignGate(),
      campaignId: "camp",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      providerIdentity: testDouble,
      executionContext: testExecutionContext,
    }) as ProviderAuthorization;

    const root = path.join(scratch, "case-d");
    const store = new ScoringStateStore({ root });
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
          executionContext: testExecutionContext,
          fixtureRootResolver: () => scratch,
          verifierLocate: () => null,
        },
        pair,
        {
          prompt: "x",
          expectedVerification: "y",
          // A perfect structural copy of a valid capability.
          authorization: { ...real } as ProviderAuthorization,
        },
      ),
    ).rejects.toThrow(/not minted by issueProviderAuthorization/u);
    expect(await countIntents(root)).toBe(0);
  }, 120_000);

  it("CASE E: sanitized environment -> TEST remains TEST", async () => {
    await initCampaign();
    const result = await runCli(billed(approvedFixture), {}, sanitizedEnv);
    expect(result.stdout).toMatch(/provider identity: TEST_DOUBLE_PROVIDER_EXECUTION/u);
    expect(result.stdout).not.toMatch(/REAL_PROVIDER_EXECUTION/u);
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

  it("the future runner tag does NOT exist yet, so real paid scoring is impossible", async () => {
    const local = await execFileAsync("git", ["rev-parse", `refs/tags/${RUNNER_TAG}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).catch(() => null);
    expect(local).toBeNull();
  }, 60_000);

  it("records the incident identity without importing any incident observation", async () => {
    expect(INCIDENT_TAG).toBe("maf-scoring-incident-2026-09-03-v1");
    expect(INCIDENT_SHA).toBe("895797e0c58099c763e206b851ba144d287394db");

    // The six accidental arm-runs must have NO path into campaign state, aggregation, or any
    // report. Proven structurally -- no scoring source reads the incident artifact at all.
    const { readdir, readFile } = await import("node:fs/promises");
    const libDir = path.join(repoRoot, "evaluation", "experiments", "scoring", "lib");
    const internalDir = path.join(libDir, "internal");
    const sources = [
      ...(await readdir(libDir)).map((f) => path.join(libDir, f)),
      ...(await readdir(internalDir)).map((f) => path.join(internalDir, f)),
      path.join(repoRoot, "evaluation", "experiments", "scoring", "run-scoring.ts"),
    ].filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/scoring-incident-2026-09-03\.json/u);
      expect(text).not.toMatch(/incidents[\\/]/u);
    }
  });

  it("leaves idempotency-key-race in its original frozen schedule position at N=3", async () => {
    // The affected task is NOT moved, removed, replaced, pre-filled, deferred, or marked invalid.
    // It is an ordinary member of the frozen suite.
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

// ============================================ STRUCTURAL RULES OVER THE TREE

describe("STRUCTURAL: no test confirms billing against real repository state", () => {
  it("every --confirm-billed-scoring in tests/ is accompanied by --test-fixture", async () => {
    // Enforced over the suite's source rather than trusted. This is the check whose absence let the
    // incident's test case exist at all.
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
      context: testExecutionContext,
    });
    expect(outcome.approved).toBe(true);
    const identity = (outcome as { approved: true; identity: ProviderIdentity }).identity;
    // Compared case-insensitively: the recorded root is the CANONICAL path, whose casing on Windows
    // comes from the filesystem rather than from however the test spelled it.
    expect(identity.testDoubleRoot?.toLowerCase()).toBe(path.join(here, "fixtures").toLowerCase());
  });

  it("a fixture root marker cannot be conjured by a marker alone", async () => {
    const dir = path.join(scratch, "marked-only");
    await mkdir(dir, { recursive: true });
    const exe = path.join(dir, "cli.mjs");
    await writeFile(exe, `// ${TEST_DOUBLE_MARKER}\n`, "utf8");
    const outcome = await approveTestDoubleProvider({
      executablePath: exe,
      context: testExecutionContext,
    });
    expect(outcome.approved).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("ROOT_MARKER_ABSENT");
  });
});

describe("STRUCTURAL: the test-support seam is unreachable from production sources", () => {
  const productionSources = async (): Promise<string[]> => {
    const { readdir } = await import("node:fs/promises");
    const scoringDir = path.join(repoRoot, "evaluation", "experiments", "scoring");
    const libDir = path.join(scoringDir, "lib");
    return [
      path.join(scoringDir, "run-scoring.ts"),
      ...(await readdir(libDir)).filter((f) => f.endsWith(".ts")).map((f) => path.join(libDir, f)),
    ];
  };

  it("no production source IMPORTS anything from lib/internal/", async () => {
    // This is the property that makes "the production CLI cannot construct a TEST context" a
    // checked fact rather than a convention.
    const { readFile } = await import("node:fs/promises");
    const offenders: string[] = [];
    for (const file of await productionSources()) {
      const text = await readFile(file, "utf8");
      // Import/export specifiers only -- prose in a comment may name the path.
      const specifiers = [...text.matchAll(/\bfrom\s+"([^"]+)"/gu)].map((m) => m[1] ?? "");
      if (specifiers.some((spec) => spec.includes("internal/"))) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("run-scoring.ts names no internal symbol and constructs only the production context", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(cli, "utf8");
    expect(text).not.toMatch(/__INTERNAL_/u);
    expect(text).not.toMatch(/createTestExecutionContext/u);
    expect(text).not.toMatch(/mintTestExecutionGateDecision/u);
    expect(text).toMatch(/createProductionExecutionContext\(/u);
  });

  it("the internal __INTERNAL_ symbols appear only at their declaration sites", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of await productionSources()) {
      const text = await readFile(file, "utf8");
      const occurrences = [...text.matchAll(/__INTERNAL_[A-Za-z]+/gu)];
      for (const occurrence of occurrences) {
        const index = occurrence.index ?? 0;
        const preceding = text.slice(Math.max(0, index - 20), index);
        // Every occurrence must be a declaration, never a use.
        expect(preceding).toMatch(/export const $/u);
      }
    }
  });
});
