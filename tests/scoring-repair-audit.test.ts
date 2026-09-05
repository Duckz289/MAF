// Coverage for the four mandatory repairs and three safety minors raised by the independent audit
// of d649bcc. Each block states the defect it locks down.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateCampaignGate,
  pairMaxExposureUsd,
  RUNS_PER_PAIR,
  summarizeCampaignSpend,
} from "../evaluation/experiments/scoring/lib/campaign-budget";
import {
  verifyRunnerFreeze,
  verifyFrozenArtifacts,
} from "../evaluation/experiments/scoring/lib/tag-verification";
import {
  assertAuthorizedForPair,
  evaluateExecutionGate,
  issueProviderAuthorization,
  type ExecutionGateDecision,
} from "../evaluation/experiments/scoring/lib/execution-gate";
import {
  executableAuthorizedForScoring,
  pinClaudeExecutable,
} from "../evaluation/experiments/scoring/lib/executable-gate";
import { inspectEffectiveClaudeConfig } from "../evaluation/experiments/scoring/lib/effective-config-gate";
import { ScoringStateStore } from "../evaluation/experiments/scoring/lib/state-store";
import { buildScoringSchedule, type RunSlot } from "../evaluation/experiments/scoring/lib/schedule";
import {
  ANALYSIS_SHA,
  PROTOCOL_V1_SHA,
  PROTOCOL_V2_SHA,
  RUNNER_TAG,
  SUITE_SHA,
  SUITE_TAG,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import type { SlotState } from "../evaluation/experiments/scoring/lib/state-store";
import type { ProviderIdentity } from "../evaluation/experiments/scoring/lib/provider-identity";
import { approvedTestDouble } from "./helpers/test-double-provider";

// ============================================================ REPAIR 1: pair exposure

const slotState = (overrides: Partial<SlotState> = {}): SlotState => ({
  slotId: "alpha__NATIVE__r1",
  status: "COMPLETE",
  generation: 1,
  observations: [],
  adjudications: [],
  rerunAuthorizations: [],
  danglingIntents: [],
  reservation: null,
  corruption: [],
  detail: "",
  ...overrides,
});

const spent = (costUsd: number | null, costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN" = "KNOWN") =>
  slotState({
    observations: [
      {
        slotId: "alpha__NATIVE__r1",
        slotDigest: "d",
        generation: 0,
        observationIndex: 1,
        taskId: "alpha",
        arm: "NATIVE" as const,
        replicate: 1,
        randomizationPosition: 0,
        sequencePosition: 0,
        recordedAt: "2026-09-02T00:00:00.000Z",
        infrastructureInvalid: false,
        dvs: true,
        runValidity: "VALID" as const,
        costUsd,
        costStatus,
        provenance: {},
      },
    ],
  });

const gate = (states: SlotState[], ceilingUsd: number | null) =>
  evaluateCampaignGate({ states, ceilingUsd, perRunCeilingUsd: 8 });

describe("REPAIR 1: the campaign gate prices a PAIR, not a single run", () => {
  it("defines pair exposure as 2 x the frozen per-run ceiling", () => {
    expect(RUNS_PER_PAIR).toBe(2);
    expect(pairMaxExposureUsd(8)).toBe(16);
    expect(gate([], 100).pairMaxExposureUsd).toBe(16);
  });

  it("authorizes at exactly $16 remaining", () => {
    const decision = gate([spent(84)], 100);
    expect(decision.remainingUsd).toBe(16);
    expect(decision.authorized).toBe(true);
  });

  it("REFUSES at $15.999 remaining -- the defect the audit found", () => {
    const decision = gate([spent(84.001)], 100);
    expect(decision.remainingUsd).toBeCloseTo(15.999, 6);
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("CEILING_WOULD_BE_EXCEEDED");
  });

  it("REFUSES at $8 remaining, which the old single-run check would have allowed", () => {
    const decision = gate([spent(92)], 100);
    expect(decision.remainingUsd).toBe(8);
    expect(decision.authorized).toBe(false);
    expect(decision.detail).toMatch(/single authorized pair may spend/u);
  });

  it("REFUSES at $0 remaining", () => {
    expect(gate([spent(100)], 100).authorized).toBe(false);
  });

  it("authorizes at $24 remaining", () => {
    expect(gate([spent(76)], 100).authorized).toBe(true);
  });

  it("REFUSES when accumulated spend is unknown", () => {
    const decision = gate([spent(null, "UNKNOWN")], 1000);
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("REMAINING_SPEND_UNKNOWABLE");
  });

  it("REFUSES when spend is only a partial lower bound", () => {
    const decision = gate([spent(5, "PARTIAL")], 1000);
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("REMAINING_SPEND_UNKNOWABLE");
  });

  it("charges ACTUAL pair cost, not the $16 exposure ceiling", () => {
    // A pair that really cost $2 total must consume $2 of the ceiling, leaving room for more pairs.
    const afterCheapPair = gate([spent(1), spent(1)], 20);
    expect(afterCheapPair.spend.knownSpendUsd).toBe(2);
    expect(afterCheapPair.remainingUsd).toBe(18);
    expect(afterCheapPair.authorized).toBe(true);
  });

  it("re-checks a full $16 exposure before each sequential pair", () => {
    const ceiling = 40;
    // Pair 1 authorized against $40.
    expect(gate([], ceiling).authorized).toBe(true);
    // Pair 1 actually cost $12 -> $28 left, still >= $16.
    const afterOne = gate([spent(7), spent(5)], ceiling);
    expect(afterOne.remainingUsd).toBe(28);
    expect(afterOne.authorized).toBe(true);
    // Pair 2 cost $13 -> $15 left, below one pair's exposure: refuse before spawning pair 3.
    const afterTwo = gate([spent(7), spent(5), spent(8), spent(5)], ceiling);
    expect(afterTwo.remainingUsd).toBe(15);
    expect(afterTwo.authorized).toBe(false);
  });

  it("never lets an outcome influence the decision", () => {
    const win = spent(50);
    const lose = spent(50);
    (lose.observations[0] as { dvs: boolean }).dvs = false;
    expect(gate([win], 100).status).toBe(gate([lose], 100).status);
  });

  it("still reports spend accounting independently of the gate", () => {
    expect(summarizeCampaignSpend([spent(3), spent(4)]).knownSpendUsd).toBe(7);
  });
});

// ============================================== REPAIR 2: runner tag local + remote

const fakeGit =
  (refs: Record<string, string>, failRemote = false) =>
  async (args: string[]): Promise<string> => {
    if (args[0] === "rev-parse" && args[1]?.startsWith("refs/tags/")) {
      const tag = args[1].replace("refs/tags/", "").replace("^{commit}", "");
      const sha = refs[`local:${tag}`];
      if (!sha) throw new Error("unknown revision");
      return `${sha}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return `${refs["HEAD"] ?? "0".repeat(40)}\n`;
    if (args[0] === "status") return refs["status"] ?? "";
    if (args[0] === "ls-remote") {
      if (failRemote) throw new Error("network unreachable");
      const tag = args[2]?.replace("refs/tags/", "").replace("^{}", "") ?? "";
      const sha = refs[`remote:${tag}`];
      if (!sha) return "";
      // Tag-object sha deliberately differs from the peeled commit sha.
      return `${"f".repeat(40)}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}\n`;
    }
    return "";
  };

const HEAD = "c".repeat(40);
const runnerRefs = (over: Record<string, string> = {}) => ({
  [`local:${RUNNER_TAG}`]: HEAD,
  [`remote:${RUNNER_TAG}`]: HEAD,
  HEAD,
  status: "",
  ...over,
});

const runnerFreeze = (
  refs: Record<string, string>,
  opts: { skipRemote?: boolean; failRemote?: boolean } = {},
) =>
  verifyRunnerFreeze({
    runnerTag: RUNNER_TAG,
    headSha: refs["HEAD"] ?? HEAD,
    options: {
      repoRoot: ".",
      git: fakeGit(refs, opts.failRemote),
      ...(opts.skipRemote ? { skipRemote: true } : {}),
    },
  });

describe("REPAIR 2: runner freeze requires local AND remote peeled == HEAD", () => {
  it("passes only on a full local+remote+HEAD match", async () => {
    const result = await runnerFreeze(runnerRefs());
    expect(result.ok).toBe(true);
    expect(result.status).toBe("OK");
    expect(result.localSha).toBe(HEAD);
    expect(result.remoteSha).toBe(HEAD);
  });

  it("refuses when the tag is absent locally", async () => {
    const refs = runnerRefs();
    delete (refs as Record<string, string>)[`local:${RUNNER_TAG}`];
    const result = await runnerFreeze(refs);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("MISSING_LOCAL");
  });

  it("refuses when the tag is absent on the remote -- the audited defect", async () => {
    const refs = runnerRefs();
    delete (refs as Record<string, string>)[`remote:${RUNNER_TAG}`];
    const result = await runnerFreeze(refs);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("MISSING_REMOTE");
  });

  it("refuses when local and remote peel to different commits", async () => {
    const result = await runnerFreeze(runnerRefs({ [`remote:${RUNNER_TAG}`]: "d".repeat(40) }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe("LOCAL_REMOTE_DIVERGED");
  });

  it("refuses when the tag does not point at the executing HEAD", async () => {
    const refs = runnerRefs({ HEAD: "e".repeat(40) });
    const result = await runnerFreeze(refs);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("HEAD_MISMATCH");
  });

  it("refuses when HEAD cannot be resolved", async () => {
    const result = await verifyRunnerFreeze({
      runnerTag: RUNNER_TAG,
      headSha: null,
      options: { repoRoot: ".", git: fakeGit(runnerRefs()) },
    });
    expect(result.status).toBe("HEAD_UNRESOLVED");
  });

  it("refuses when the remote lookup fails outright", async () => {
    const result = await runnerFreeze(runnerRefs(), { failRemote: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("MISSING_REMOTE");
  });

  it("refuses skipRemote on the billed path even with a perfect local tag", async () => {
    const result = await runnerFreeze(runnerRefs(), { skipRemote: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("REMOTE_NOT_CHECKED");
    expect(result.remoteChecked).toBe(false);
  });

  it("never accepts the annotated tag-object sha in place of the peeled commit", async () => {
    // The fake remote always returns f*40 as the tag-object sha; only the peeled line matches HEAD.
    const result = await runnerFreeze(runnerRefs());
    expect(result.remoteSha).toBe(HEAD);
    expect(result.remoteSha).not.toBe("f".repeat(40));
  });
});

describe("REPAIR 2b: the execution gate enforces remote verification", () => {
  const fullRefs = (over: Record<string, string> = {}) => ({
    [`local:${SUITE_TAG}`]: SUITE_SHA,
    [`remote:${SUITE_TAG}`]: SUITE_SHA,
    "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
    "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
    [`local:${RUNNER_TAG}`]: HEAD,
    [`remote:${RUNNER_TAG}`]: HEAD,
    HEAD,
    status: "",
    ...over,
  });

  let testDouble: ProviderIdentity;
  beforeAll(async () => {
    testDouble = await approvedTestDouble();
  });

  const gateInput = (over: Record<string, unknown> = {}) => ({
    repoRoot: ".",
    billedConfirmed: true,
    // Runner v2 structural inputs. These unit tests exercise the FROZEN-ARTIFACT gates, so they
    // present the configuration a legitimate simulation would: an approved test double, injected
    // git state, and an explicit TEST context. Anything less would now be refused by
    // PROVIDER_IDENTITY / TEST_CONTEXT_ISOLATION before the checks under test were reached.
    providerIdentity: testDouble,
    providerIdentityDetail: testDouble.detail,
    gitStateInjected: true,
    executionContext: {
      kind: "TEST" as const,
      signals: ["unit-test"],
      detail: "unit test harness",
    },

    manifest: {
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "high",
      timeoutMs: 1_800_000,
      perRunCeilingUsd: 8,
      runsPerTask: 3,
      totalScoringRunsPlanned: 174,
      suiteTag: SUITE_TAG,
      suiteSha: SUITE_SHA,
    },
    slotStates: [] as SlotState[],
    campaignGate: gate([], 100),
    pinnedExecutable: {
      pinned: true,
      path: "C:/tools/claude.exe",
      version: "2.1.251",
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      firstParty: true,
      probedPaths: ["C:/tools/claude.exe"],
      pathIsAbsolute: true,
      detail: "pinned",
    },
    routing: {
      externalModelOverrideForwarded: false,
      externalBaseUrlOverrideForwarded: false,
      externalAuthTokenForwarded: false,
      detail: "clean",
    },
    effectiveConfig: {
      clean: true,
      checks: [],
      inspectedFiles: [],
      excludedPaths: [],
      summary: "clean",
    },
    git: fakeGit(fullRefs()),
    ...over,
  });

  it("authorizes when everything including the runner tag is correct", async () => {
    const decision = await evaluateExecutionGate(gateInput() as never);
    expect(decision.failures.map((f) => f.id)).toEqual([]);
    expect(decision.authorized).toBe(true);
  });

  it("REFUSES a billed run when skipRemote was used", async () => {
    const decision = await evaluateExecutionGate(gateInput({ skipRemote: true }) as never);
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("REMOTE_VERIFICATION_PERFORMED");
  });

  it("REFUSES when the runner tag exists locally but not on the remote", async () => {
    const refs = fullRefs();
    delete (refs as Record<string, string>)[`remote:${RUNNER_TAG}`];
    const decision = await evaluateExecutionGate(gateInput({ git: fakeGit(refs) }) as never);
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("RUNNER_FROZEN");
  });

  it("REFUSES when the runner tag does not match the executing HEAD", async () => {
    const decision = await evaluateExecutionGate(
      gateInput({ git: fakeGit(fullRefs({ HEAD: "9".repeat(40) })) }) as never,
    );
    expect(decision.failures.map((f) => f.id)).toContain("RUNNER_FROZEN");
  });
});

// ================================ REPAIR 3: one executable for version, auth, execution

describe("REPAIR 3: version, auth and execution share ONE resolved executable", () => {
  const fakeResolve = (pathValue: string | null) => async (preferred?: string) => ({
    resolved: pathValue !== null,
    path: pathValue === null ? null : (preferred ?? pathValue),
    version: pathValue === null ? null : "2.1.251 (Claude Code)",
    detail: pathValue === null ? "not found" : "resolved",
  });

  const fakeAuth =
    (over: Partial<{ loggedIn: boolean; authMethod: string; apiProvider: string }> = {}) =>
    async (executablePath: string) => {
      seenAuthPaths.push(executablePath);
      return {
        checked: true,
        loggedIn: over.loggedIn ?? true,
        authMethod: over.authMethod ?? "claude.ai",
        apiProvider: over.apiProvider ?? "firstParty",
        detail: "probe",
      };
    };

  let seenAuthPaths: string[] = [];
  beforeEach(() => {
    seenAuthPaths = [];
  });

  it("probes version and auth against the SAME path and reports it once", async () => {
    const pinned = await pinClaudeExecutable({
      preferredPath: "C:/pinned/claude.exe",
      resolve: fakeResolve("C:/pinned/claude.exe"),
      checkAuth: fakeAuth(),
    });
    expect(pinned.pinned).toBe(true);
    expect(pinned.path).toBe("C:/pinned/claude.exe");
    expect(new Set(pinned.probedPaths).size).toBe(1);
    expect(seenAuthPaths).toEqual(["C:/pinned/claude.exe"]);
    expect(executableAuthorizedForScoring(pinned)).toBe(true);
  });

  it("blocks when the executable cannot be resolved at all", async () => {
    const pinned = await pinClaudeExecutable({
      resolve: fakeResolve(null),
      checkAuth: fakeAuth(),
    });
    expect(pinned.pinned).toBe(false);
    expect(executableAuthorizedForScoring(pinned)).toBe(false);
    // Auth was never probed against a phantom path.
    expect(seenAuthPaths).toEqual([]);
  });

  it("blocks when logged out", async () => {
    const pinned = await pinClaudeExecutable({
      resolve: fakeResolve("C:/claude.exe"),
      checkAuth: fakeAuth({ loggedIn: false }),
    });
    expect(pinned.loggedIn).toBe(false);
    expect(executableAuthorizedForScoring(pinned)).toBe(false);
  });

  it("blocks a non-first-party provider", async () => {
    const pinned = await pinClaudeExecutable({
      resolve: fakeResolve("C:/claude.exe"),
      checkAuth: fakeAuth({ apiProvider: "thirdParty" }),
    });
    expect(pinned.firstParty).toBe(false);
    expect(executableAuthorizedForScoring(pinned)).toBe(false);
    expect(pinned.detail).toMatch(/not a first-party/u);
  });

  it("blocks an unrecognized auth method even when the provider claims firstParty", async () => {
    const pinned = await pinClaudeExecutable({
      resolve: fakeResolve("C:/claude.exe"),
      checkAuth: fakeAuth({ authMethod: "api_key" }),
    });
    expect(pinned.firstParty).toBe(false);
    expect(executableAuthorizedForScoring(pinned)).toBe(false);
  });

  it("accepts oauth_token as a first-party session", async () => {
    const pinned = await pinClaudeExecutable({
      resolve: fakeResolve("C:/claude.exe"),
      checkAuth: fakeAuth({ authMethod: "oauth_token" }),
    });
    expect(executableAuthorizedForScoring(pinned)).toBe(true);
  });

  it("resolves a bare command to an absolute path before probing it", async () => {
    const pinned = await pinClaudeExecutable({
      locate: async () => ["C:\\Users\\Admin\\.local\\bin\\claude.exe"],
      resolve: fakeResolve("ignored"),
      checkAuth: fakeAuth(),
    });
    expect(pinned.pathIsAbsolute).toBe(true);
    expect(seenAuthPaths).toEqual(["C:\\Users\\Admin\\.local\\bin\\claude.exe"]);
    expect(executableAuthorizedForScoring(pinned)).toBe(true);
  });

  it("REFUSES a bare command that cannot be resolved to an absolute path", async () => {
    // Every spawn would repeat a PATH lookup that could resolve to a different binary.
    const pinned = await pinClaudeExecutable({
      locate: async () => [],
      resolve: fakeResolve("claude"),
      checkAuth: fakeAuth(),
    });
    expect(pinned.pathIsAbsolute).toBe(false);
    expect(pinned.pinned).toBe(false);
    expect(executableAuthorizedForScoring(pinned)).toBe(false);
    expect(pinned.detail).toMatch(/not an absolute path/u);
  });

  it("survives a failing locate command by refusing rather than guessing", async () => {
    const pinned = await pinClaudeExecutable({
      locate: async () => {
        throw new Error("where.exe unavailable");
      },
      resolve: fakeResolve("claude"),
      checkAuth: fakeAuth(),
    });
    expect(pinned.pinned).toBe(false);
  });

  it("resolves the REAL executable to an absolute, authenticated, first-party binary", async () => {
    // Live, non-inference: `--version` and `auth status` only. No model is invoked.
    const pinned = await pinClaudeExecutable();
    expect(pinned.pathIsAbsolute).toBe(true);
    expect(pinned.path).toMatch(/claude(\.exe)?$/iu);
    expect(new Set(pinned.probedPaths).size).toBe(1);
    expect(pinned.loggedIn).toBe(true);
    expect(pinned.apiProvider).toBe("firstParty");
    expect(executableAuthorizedForScoring(pinned)).toBe(true);
  });
});

// ======================== REPAIR 4: authorization enforced at the spawn boundary

describe("REPAIR 4: provider authorization is a capability, checked at the boundary", () => {
  const schedule = buildScoringSchedule({
    randomization: {
      seed: "auth-test",
      taskOrder: ["alpha", "beta"],
      armOrder: { alpha: "NATIVE_FIRST", beta: "MAF_FIRST" },
    },
    frozenTaskIds: ["alpha", "beta"],
    runsPerTask: 3,
  });
  const nativeSlot = schedule.slots.find(
    (s) => s.taskId === "alpha" && s.arm === "NATIVE" && s.replicate === 1,
  ) as RunSlot;
  const mafSlot = schedule.slots.find(
    (s) => s.taskId === "alpha" && s.arm === "MAF" && s.replicate === 1,
  ) as RunSlot;
  const otherNative = schedule.slots.find(
    (s) => s.taskId === "beta" && s.arm === "NATIVE" && s.replicate === 1,
  ) as RunSlot;

  const decision = (authorized: boolean): ExecutionGateDecision => ({
    authorized,
    checks: [],
    failures: authorized ? [] : [{ id: "RUNNER_FROZEN", passed: false, detail: "absent" }],
    protocolFreezeAuthority: "GIT_TAG",
    protocolFrozen: true,
    knownSourceMetadataNote: "note",
    summary: authorized ? "ok" : "refused",
  });

  // Runner v2: the capability binds an approved provider IDENTITY, not a path string. A synthetic
  // "C:/tools/claude.exe" is no longer expressible here -- which is the point, since that string is
  // exactly what a test would have had to supply to reach the real provider under Runner v1.
  let testDouble: ProviderIdentity;
  let ABSOLUTE_EXE: string;
  let context: {
    campaignId: string;
    scheduleDigest: string;
    nativeSlotDigest: string;
    mafSlotDigest: string;
    executablePath: string;
  };
  beforeAll(async () => {
    testDouble = await approvedTestDouble();
    ABSOLUTE_EXE = testDouble.executablePath;
    context = {
      campaignId: "camp-1",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: nativeSlot.slotDigest,
      mafSlotDigest: mafSlot.slotDigest,
      executablePath: ABSOLUTE_EXE,
    };
  });

  it("cannot be minted from a REFUSED decision", () => {
    expect(
      issueProviderAuthorization({
        decision: decision(false),
        campaignId: "camp-1",
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: nativeSlot.slotDigest,
        mafSlotDigest: mafSlot.slotDigest,
        providerIdentity: testDouble,
      }),
    ).toBeNull();
  });

  it("cannot be minted without an established provider identity", () => {
    expect(
      issueProviderAuthorization({
        decision: decision(true),
        campaignId: "camp-1",
        scheduleDigest: schedule.scheduleDigest,
        nativeSlotDigest: nativeSlot.slotDigest,
        mafSlotDigest: mafSlot.slotDigest,
        providerIdentity: undefined as unknown as ProviderIdentity,
      }),
    ).toBeNull();
  });

  it("throws when no capability is supplied at all", () => {
    expect(() => assertAuthorizedForPair(undefined, context)).toThrow(
      /no provider authorization was supplied/u,
    );
  });

  it("accepts a capability issued for exactly this pair", () => {
    const auth = issueProviderAuthorization({
      decision: decision(true),
      campaignId: "camp-1",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: nativeSlot.slotDigest,
      mafSlotDigest: mafSlot.slotDigest,
      providerIdentity: testDouble,
    });
    expect(() => assertAuthorizedForPair(auth ?? undefined, context)).not.toThrow();
  });

  it("REFUSES a capability replayed against a different pair", () => {
    const auth = issueProviderAuthorization({
      decision: decision(true),
      campaignId: "camp-1",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: otherNative.slotDigest,
      mafSlotDigest: mafSlot.slotDigest,
      providerIdentity: testDouble,
    });
    expect(() => assertAuthorizedForPair(auth ?? undefined, context)).toThrow(
      /issued for a different execution/u,
    );
  });

  it("REFUSES a capability from a different campaign", () => {
    const auth = issueProviderAuthorization({
      decision: decision(true),
      campaignId: "some-other-campaign",
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: nativeSlot.slotDigest,
      mafSlotDigest: mafSlot.slotDigest,
      providerIdentity: testDouble,
    });
    expect(() => assertAuthorizedForPair(auth ?? undefined, context)).toThrow(/campaign/u);
  });

  it("REFUSES a capability from a different schedule", () => {
    const auth = issueProviderAuthorization({
      decision: decision(true),
      campaignId: "camp-1",
      scheduleDigest: "a-different-digest",
      nativeSlotDigest: nativeSlot.slotDigest,
      mafSlotDigest: mafSlot.slotDigest,
      providerIdentity: testDouble,
    });
    expect(() => assertAuthorizedForPair(auth ?? undefined, context)).toThrow(/schedule digest/u);
  });
});

// ================================= MINOR A: workspace-level active config

describe("MINOR A: workspace-local Claude config is inspected too", () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "maf-cfg-home-"));
    workspace = await mkdtemp(path.join(tmpdir(), "maf-cfg-ws-"));
    await writeFile(path.join(home, "placeholder"), "", "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });

  const writeWorkspaceConfig = async (filename: string, contents: unknown) => {
    const dir = path.join(workspace, ".claude");
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), JSON.stringify(contents), "utf8");
  };

  it("passes when the workspace has no Claude config", async () => {
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: {},
      workspacePaths: [workspace],
    });
    expect(report.clean).toBe(true);
  });

  it("BLOCKS a workspace settings.json that redirects to Stali", async () => {
    await writeWorkspaceConfig("settings.json", {
      env: { ANTHROPIC_BASE_URL: "https://api.stali.vn/v1" },
    });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: {},
      workspacePaths: [workspace],
    });
    expect(report.clean).toBe(false);
    expect(report.inspectedFiles.some((f) => f.startsWith(workspace))).toBe(true);
  });

  it("BLOCKS a workspace settings.local.json carrying an auth token", async () => {
    await writeWorkspaceConfig("settings.local.json", {
      env: { ANTHROPIC_AUTH_TOKEN: "sk-should-never-be-printed" },
    });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: {},
      workspacePaths: [workspace],
    });
    expect(report.clean).toBe(false);
    expect(JSON.stringify(report)).not.toContain("sk-should-never-be-printed");
  });

  it("BLOCKS a workspace override naming an alternate model route", async () => {
    await writeWorkspaceConfig("settings.json", { env: { ANTHROPIC_MODEL: "req/kimi-k3" } });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: {},
      workspacePaths: [workspace],
    });
    expect(report.clean).toBe(false);
  });

  it("still ignores historical material inside the workspace", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(workspace, ".claude", "backups"), { recursive: true });
    await writeFile(
      path.join(workspace, ".claude", "backups", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.stali.vn" } }),
      "utf8",
    );
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: {},
      workspacePaths: [workspace],
    });
    expect(report.clean).toBe(true);
  });
});

// ========================== MINOR B/C: campaign init safety and lease semantics

describe("MINOR B: campaign init never silently overwrites", () => {
  let root: string;
  const schedule = buildScoringSchedule({
    randomization: {
      seed: "init-test",
      taskOrder: ["alpha"],
      armOrder: { alpha: "NATIVE_FIRST" },
    },
    frozenTaskIds: ["alpha"],
    runsPerTask: 3,
  });

  const metadata = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      campaignId: "camp-1",
      createdAt: "2026-09-02T00:00:00.000Z",
      suiteTag: SUITE_TAG,
      suiteSha: SUITE_SHA,
      protocolTag: "maf-experiment-protocol-v2",
      protocolSha: PROTOCOL_V2_SHA,
      analysisTag: "maf-experiment-analysis-v1",
      analysisSha: ANALYSIS_SHA,
      analysisVersion: "1.0.0",
      runnerVersion: "1.0.0",
      runnerTag: RUNNER_TAG,
      runnerSha: null,
      scheduleDigest: schedule.scheduleDigest,
      totalSlots: schedule.slots.length,
      campaignCeilingUsd: 100,
      protocolFreezeAuthority: "GIT_TAG",
      protocolFrozen: true,
      knownSourceMetadataNote: "note",
      ...over,
    }) as never;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maf-init-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a campaign the first time", async () => {
    const store = new ScoringStateStore({ root });
    const result = await store.createCampaign(metadata());
    expect(result.created).toBe(true);
  });

  it("REFUSES a second init and preserves the original identity", async () => {
    const store = new ScoringStateStore({ root });
    await store.createCampaign(metadata());
    const second = await store.createCampaign(metadata({ campaignId: "camp-2" }));
    expect(second.created).toBe(false);
    expect(second.existing?.campaignId).toBe("camp-1");
    expect(second.detail).toMatch(/Refusing to overwrite/u);

    const stored = await store.readCampaign();
    expect(stored.status === "OK" && stored.record.payload.campaignId).toBe("camp-1");
  });

  it("refuses to replace an existing schedule with a different one", async () => {
    const store = new ScoringStateStore({ root });
    await store.createSchedule(schedule);
    const other = buildScoringSchedule({
      randomization: { seed: "different", taskOrder: ["alpha"], armOrder: { alpha: "MAF_FIRST" } },
      frozenTaskIds: ["alpha"],
      runsPerTask: 3,
    });
    const result = await store.createSchedule(other);
    expect(result.created).toBe(false);
    expect(result.matches).toBe(false);
  });

  it("resumes a campaign whose frozen identity matches", async () => {
    const store = new ScoringStateStore({ root });
    await store.createCampaign(metadata());
    const opened = await store.openCampaign({
      suiteSha: SUITE_SHA,
      protocolSha: PROTOCOL_V2_SHA,
      analysisSha: ANALYSIS_SHA,
      scheduleDigest: schedule.scheduleDigest,
    });
    expect(opened.opened).toBe(true);
  });

  it("REFUSES to resume a campaign collected under different frozen inputs", async () => {
    const store = new ScoringStateStore({ root });
    await store.createCampaign(metadata({ analysisSha: "9".repeat(40) }));
    const opened = await store.openCampaign({
      suiteSha: SUITE_SHA,
      protocolSha: PROTOCOL_V2_SHA,
      analysisSha: ANALYSIS_SHA,
      scheduleDigest: schedule.scheduleDigest,
    });
    expect(opened.opened).toBe(false);
    if (!opened.opened) expect(opened.mismatches.join(" ")).toMatch(/analysisSha/u);
  });

  it("refuses to resume when no campaign exists", async () => {
    const store = new ScoringStateStore({ root });
    const opened = await store.openCampaign({
      suiteSha: SUITE_SHA,
      protocolSha: PROTOCOL_V2_SHA,
      analysisSha: ANALYSIS_SHA,
      scheduleDigest: schedule.scheduleDigest,
    });
    expect(opened.opened).toBe(false);
  });
});

describe("MINOR C: the lease governs only the claim -> intent window", () => {
  let root: string;
  let clock: number;
  const schedule = buildScoringSchedule({
    randomization: { seed: "lease", taskOrder: ["alpha"], armOrder: { alpha: "NATIVE_FIRST" } },
    frozenTaskIds: ["alpha"],
    runsPerTask: 3,
  });
  const slot = schedule.slots[0] as RunSlot;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maf-lease-"));
    clock = 1_000_000;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const store = (owner: string) =>
    new ScoringStateStore({ root, owner, leaseMs: 1000, now: () => clock });

  it("expired lease BEFORE intent is safely reclaimable", async () => {
    expect((await store("a").claimSlot(slot)).claimed).toBe(true);
    clock += 5000;
    const state = await store("b").inspectSlot(slot.slotId);
    expect(state.status).toBe("RECLAIMABLE");
    expect((await store("b").claimSlot(slot)).claimed).toBe(true);
  });

  it("expired lease AFTER intent is NEVER reclaimable, however stale", async () => {
    const a = store("a");
    await a.claimSlot(slot);
    await a.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });
    // Far beyond any lease: a 30-minute run must not be reclaimed out from under itself.
    clock += 60 * 60 * 1000;
    const state = await store("b").inspectSlot(slot.slotId);
    expect(state.status).toBe("RECOVERY_REQUIRED");
    expect((await store("b").claimSlot(slot)).claimed).toBe(false);
  });

  it("documents that the lease covers only the pre-intent window", () => {
    expect(store("a").leaseCoversPreIntentWindowOnly).toBe(true);
  });
});
