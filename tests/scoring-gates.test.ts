import { describe, expect, it } from "vitest";
import {
  evaluateCampaignGate,
  summarizeCampaignSpend,
  theoreticalMaximumCampaignUsd,
} from "../evaluation/experiments/scoring/lib/campaign-budget";
import {
  checkManifestParameters,
  evaluateExecutionGate,
  assertAuthorizedForProviderCall,
  type ManifestParameters,
} from "../evaluation/experiments/scoring/lib/execution-gate";
import {
  verifyFrozenArtifacts,
  verifyFrozenTag,
} from "../evaluation/experiments/scoring/lib/tag-verification";
import {
  ANALYSIS_SHA,
  PROTOCOL_V1_SHA,
  PROTOCOL_V2_SHA,
  RUNNER_TAG,
  SUITE_SHA,
  SUITE_TAG,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import type { SlotState } from "../evaluation/experiments/scoring/lib/state-store";

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

const observation = (costUsd: number | null, costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN") => ({
  slotId: "alpha__NATIVE__r1",
  slotDigest: "d",
  generation: 0,
  observationIndex: 1,
  taskId: "alpha",
  arm: "NATIVE" as const,
  replicate: 1,
  randomizationPosition: 0,
  sequencePosition: 0,
  recordedAt: "2026-09-01T00:00:00.000Z",
  infrastructureInvalid: false,
  dvs: true,
  runValidity: "VALID" as const,
  costUsd,
  costStatus,
  provenance: {},
});

// ------------------------------------------------------------ campaign cost

describe("campaign spend accounting", () => {
  it("sums known costs and reports a clean KNOWN status", () => {
    const spend = summarizeCampaignSpend([
      slotState({ observations: [observation(2, "KNOWN")] }),
      slotState({ observations: [observation(3, "KNOWN")] }),
    ]);
    expect(spend.knownSpendUsd).toBe(5);
    expect(spend.spendStatus).toBe("KNOWN");
    expect(spend.headroomUnknowable).toBe(false);
  });

  it("never treats an unmeasured cost as zero", () => {
    const spend = summarizeCampaignSpend([
      slotState({ observations: [observation(2, "KNOWN")] }),
      slotState({ observations: [observation(null, "UNKNOWN")] }),
    ]);
    expect(spend.knownSpendUsd).toBe(2);
    expect(spend.unknownCostObservations).toBe(1);
    expect(spend.headroomUnknowable).toBe(true);
  });

  it("reports the frozen theoretical maximum", () => {
    expect(theoreticalMaximumCampaignUsd(174, 8)).toBe(1392);
  });
});

describe("campaign cost gate (Phase 12)", () => {
  it("refuses when no operator ceiling is configured", () => {
    const decision = evaluateCampaignGate({
      states: [],
      ceilingUsd: null,
      perRunCeilingUsd: 8,
    });
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("NO_CEILING_CONFIGURED");
    expect(decision.detail).toMatch(/no default is baked in/u);
  });

  it("authorizes while a full frozen run still fits under the ceiling", () => {
    const decision = evaluateCampaignGate({
      states: [slotState({ observations: [observation(50, "KNOWN")] })],
      ceilingUsd: 100,
      perRunCeilingUsd: 8,
    });
    expect(decision.authorized).toBe(true);
    expect(decision.remainingUsd).toBe(50);
  });

  it("stops BEFORE spawn when the next run could breach the ceiling", () => {
    const decision = evaluateCampaignGate({
      states: [slotState({ observations: [observation(95, "KNOWN")] })],
      ceilingUsd: 100,
      perRunCeilingUsd: 8,
    });
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("CEILING_WOULD_BE_EXCEEDED");
  });

  it("compares against the full per-run ceiling, not an average", () => {
    // $7 of headroom is plenty on average but a single run may spend $8, so it must refuse.
    const decision = evaluateCampaignGate({
      states: [slotState({ observations: [observation(93, "KNOWN")] })],
      ceilingUsd: 100,
      perRunCeilingUsd: 8,
    });
    expect(decision.authorized).toBe(false);
  });

  it("fails closed when accumulated spend is unknowable", () => {
    const decision = evaluateCampaignGate({
      states: [slotState({ observations: [observation(null, "UNKNOWN")] })],
      ceilingUsd: 1000,
      perRunCeilingUsd: 8,
    });
    expect(decision.authorized).toBe(false);
    expect(decision.status).toBe("REMAINING_SPEND_UNKNOWABLE");
    expect(decision.remainingUsd).toBeNull();
  });

  it("never consults an outcome: identical spend authorizes identically regardless of DVS", () => {
    const winning = slotState({ observations: [{ ...observation(50, "KNOWN"), dvs: true }] });
    const losing = slotState({ observations: [{ ...observation(50, "KNOWN"), dvs: false }] });
    const a = evaluateCampaignGate({ states: [winning], ceilingUsd: 100, perRunCeilingUsd: 8 });
    const b = evaluateCampaignGate({ states: [losing], ceilingUsd: 100, perRunCeilingUsd: 8 });
    expect(a.status).toBe(b.status);
    expect(a.remainingUsd).toBe(b.remainingUsd);
  });
});

// -------------------------------------------------------------- tag gating

const fakeGit =
  (refs: Record<string, string>) =>
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
      // Mirrors the real query shape: `ls-remote origin refs/tags/<tag> refs/tags/<tag>^{}`.
      const tag = args[2]?.replace("refs/tags/", "").replace("^{}", "") ?? "";
      const sha = refs[`remote:${tag}`];
      if (!sha) return "";
      // The tag-object sha deliberately differs from the peeled commit sha, so a verifier that
      // compared the wrong line would fail against this fixture rather than silently pass.
      return `${"f".repeat(40)}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}\n`;
    }
    return "";
  };

describe("post-freeze tag verification (Phase 1)", () => {
  const goodRefs = {
    [`local:${SUITE_TAG}`]: SUITE_SHA,
    [`remote:${SUITE_TAG}`]: SUITE_SHA,
    "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
    "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
  };

  it("REQUIRES the v2 tag to exist, unlike the historical pre-freeze validator", async () => {
    const result = await verifyFrozenArtifacts({ repoRoot: ".", git: fakeGit(goodRefs) });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.status === "OK")).toBe(true);
  });

  it("fails when a frozen tag is missing locally", async () => {
    const refs = { ...goodRefs };
    delete (refs as Record<string, string>)["local:maf-experiment-protocol-v2"];
    const result = await verifyFrozenArtifacts({ repoRoot: ".", git: fakeGit(refs) });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/does not exist locally/u);
  });

  it("fails when a frozen tag has been MOVED to another commit", async () => {
    const result = await verifyFrozenTag(
      { tag: SUITE_TAG, expectedSha: SUITE_SHA },
      { repoRoot: ".", git: fakeGit({ ...goodRefs, [`local:${SUITE_TAG}`]: "a".repeat(40) }) },
    );
    expect(result.status).toBe("LOCAL_MISMATCH");
  });

  it("fails when the remote tag disagrees with the local one", async () => {
    const result = await verifyFrozenTag(
      { tag: SUITE_TAG, expectedSha: SUITE_SHA },
      { repoRoot: ".", git: fakeGit({ ...goodRefs, [`remote:${SUITE_TAG}`]: "b".repeat(40) }) },
    );
    expect(result.status).toBe("REMOTE_MISMATCH");
  });

  it("compares the PEELED commit, so a re-pointed annotated tag cannot pass", async () => {
    // The fake remote always returns a different tag-object sha; only the peeled line may match.
    const result = await verifyFrozenTag(
      { tag: SUITE_TAG, expectedSha: SUITE_SHA },
      { repoRoot: ".", git: fakeGit(goodRefs) },
    );
    expect(result.remoteSha).toBe(SUITE_SHA);
    expect(result.status).toBe("OK");
  });

  it("reports that the remote was not checked when skipping it", async () => {
    const result = await verifyFrozenArtifacts({
      repoRoot: ".",
      skipRemote: true,
      git: fakeGit(goodRefs),
    });
    expect(result.remoteChecked).toBe(false);
  });
});

// --------------------------------------------------------- execution gate

const goodManifest: ManifestParameters = {
  model: "claude-sonnet-5",
  provider: "anthropic",
  effort: "high",
  timeoutMs: 1_800_000,
  perRunCeilingUsd: 8,
  runsPerTask: 3,
  totalScoringRunsPlanned: 174,
  suiteTag: SUITE_TAG,
  suiteSha: SUITE_SHA,
};

describe("manifest parameter parity (Phase 10)", () => {
  it("passes when every frozen parameter matches", () => {
    expect(checkManifestParameters(goodManifest).passed).toBe(true);
  });

  it.each([
    ["model", { model: "claude-opus-5" }],
    ["effort", { effort: "medium" }],
    ["timeoutMs", { timeoutMs: 900_000 }],
    ["perRunCeilingUsd", { perRunCeilingUsd: 16 }],
    ["runsPerTask", { runsPerTask: 5 }],
    ["totalScoringRunsPlanned", { totalScoringRunsPlanned: 290 }],
    ["suiteSha", { suiteSha: "a".repeat(40) }],
  ])("rejects a drifted %s", (_label, override) => {
    const check = checkManifestParameters({ ...goodManifest, ...override });
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/manifest disagrees with the frozen protocol/u);
  });
});

describe("billed scoring execution gate (Phases 14/15)", () => {
  const baseInput = (overrides: Record<string, unknown> = {}) => ({
    repoRoot: ".",
    billedConfirmed: true,
    manifest: goodManifest,
    slotStates: [] as SlotState[],
    campaignGate: {
      status: "AUTHORIZED" as const,
      authorized: true,
      spend: summarizeCampaignSpend([]),
      ceilingUsd: 100,
      perRunCeilingUsd: 8,
      remainingUsd: 100,
      detail: "ok",
    },
    auth: {
      loggedIn: true,
      apiProvider: "firstParty",
      authMethod: "claude.ai",
      executablePath: "C:/tools/claude.exe",
      executableVersion: "2.1.251 (Claude Code)",
      detail: "authenticated",
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
      inspectedFiles: ["settings.json"],
      excludedPaths: [],
      summary: "effective Claude configuration is clean",
    },
    git: fakeGit({
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
      [`local:${RUNNER_TAG}`]: "c".repeat(40),
      [`remote:${RUNNER_TAG}`]: "c".repeat(40),
      HEAD: "c".repeat(40),
      status: "",
    }),
    ...overrides,
  });

  it("REFUSES while the runner freeze tag does not exist", async () => {
    const git = fakeGit({
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
      HEAD: "c".repeat(40),
      status: "",
    });
    const decision = await evaluateExecutionGate(baseInput({ git }) as never);
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("RUNNER_FROZEN");
    expect(() => assertAuthorizedForProviderCall(decision)).toThrow(/SCORING_EXECUTION_REFUSED/u);
  });

  it("authorizes only when every gate passes", async () => {
    const decision = await evaluateExecutionGate(baseInput() as never);
    expect(decision.failures).toEqual([]);
    expect(decision.authorized).toBe(true);
  });

  it("refuses without explicit billed confirmation", async () => {
    const decision = await evaluateExecutionGate(baseInput({ billedConfirmed: false }) as never);
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("BILLED_CONFIRMATION");
  });

  it("refuses when the executing source is not the frozen runner revision", async () => {
    const git = fakeGit({
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
      [`local:${RUNNER_TAG}`]: "c".repeat(40),
      [`remote:${RUNNER_TAG}`]: "c".repeat(40),
      HEAD: "d".repeat(40),
      status: "",
    });
    const decision = await evaluateExecutionGate(baseInput({ git }) as never);
    expect(decision.failures.map((f) => f.id)).toContain("RUNNER_MATCHES_HEAD");
  });

  it("refuses on a dirty worktree", async () => {
    const git = fakeGit({
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
      [`local:${RUNNER_TAG}`]: "c".repeat(40),
      [`remote:${RUNNER_TAG}`]: "c".repeat(40),
      HEAD: "c".repeat(40),
      status: " M src/thing.ts",
    });
    const decision = await evaluateExecutionGate(baseInput({ git }) as never);
    expect(decision.failures.map((f) => f.id)).toContain("WORKTREE_CLEAN");
  });

  it("refuses when auth is unverified", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({ auth: { loggedIn: false, detail: "not probed" } }) as never,
    );
    expect(decision.failures.map((f) => f.id)).toContain("CLAUDE_AUTH");
  });

  it("refuses when alternate provider routing would reach the participant", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({
        routing: {
          externalModelOverrideForwarded: true,
          externalBaseUrlOverrideForwarded: false,
          externalAuthTokenForwarded: false,
          detail: "override present",
        },
      }) as never,
    );
    expect(decision.failures.map((f) => f.id)).toContain("PROVIDER_ROUTING");
  });

  it("refuses when any slot holds a possibly-billed ambiguous attempt", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({
        slotStates: [slotState({ status: "RECOVERY_REQUIRED", slotId: "alpha__MAF__r2" })],
      }) as never,
    );
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("NO_AMBIGUOUS_RECOVERY");
  });

  it("refuses when any slot record is corrupt", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({ slotStates: [slotState({ status: "CORRUPT" })] }) as never,
    );
    expect(decision.failures.map((f) => f.id)).toContain("STATE_STORE_INTEGRITY");
  });

  it("REFUSES when the analysis freeze tag is missing", async () => {
    const refs = {
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      [`local:${RUNNER_TAG}`]: "c".repeat(40),
      [`remote:${RUNNER_TAG}`]: "c".repeat(40),
      HEAD: "c".repeat(40),
      status: "",
    };
    const decision = await evaluateExecutionGate(baseInput({ git: fakeGit(refs) }) as never);
    expect(decision.authorized).toBe(false);
    expect(decision.failures.map((f) => f.id)).toContain("ANALYSIS_FROZEN");
  });

  it("REFUSES when the analysis tag points at the wrong commit", async () => {
    const refs = {
      [`local:${SUITE_TAG}`]: SUITE_SHA,
      [`remote:${SUITE_TAG}`]: SUITE_SHA,
      "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
      "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
      "local:maf-experiment-analysis-v1": "9".repeat(40),
      "remote:maf-experiment-analysis-v1": "9".repeat(40),
      [`local:${RUNNER_TAG}`]: "c".repeat(40),
      [`remote:${RUNNER_TAG}`]: "c".repeat(40),
      HEAD: "c".repeat(40),
      status: "",
    };
    const decision = await evaluateExecutionGate(baseInput({ git: fakeGit(refs) }) as never);
    expect(decision.failures.map((f) => f.id)).toContain("ANALYSIS_FROZEN");
  });

  it("refuses an authenticated session that is NOT first-party", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({
        auth: {
          loggedIn: true,
          apiProvider: "thirdParty",
          authMethod: "api_key",
          executablePath: "C:/tools/claude.exe",
          executableVersion: "2.1.251",
          detail: "authenticated elsewhere",
        },
      }) as never,
    );
    expect(decision.authorized).toBe(false);
    const auth = decision.checks.find((c) => c.id === "CLAUDE_AUTH");
    expect(auth?.passed).toBe(false);
    expect(auth?.detail).toMatch(/not firstParty/u);
  });

  it("refuses when no single executable was pinned for version, auth and execution", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({
        auth: {
          loggedIn: true,
          apiProvider: "firstParty",
          authMethod: "claude.ai",
          executablePath: null,
          executableVersion: null,
          detail: "authenticated",
        },
      }) as never,
    );
    expect(decision.failures.map((f) => f.id)).toContain("CLAUDE_EXECUTABLE_PINNED");
  });

  it("refuses when the effective Claude configuration would redirect the participant", async () => {
    const decision = await evaluateExecutionGate(
      baseInput({
        effectiveConfig: {
          clean: false,
          checks: [],
          inspectedFiles: ["settings.json"],
          excludedPaths: [],
          summary: "active Claude configuration sets ANTHROPIC_BASE_URL",
        },
      }) as never,
    );
    expect(decision.authorized).toBe(false);
    const check = decision.checks.find((c) => c.id === "EFFECTIVE_CLAUDE_CONFIG");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/ANTHROPIC_BASE_URL/u);
  });

  it("reaches AUTHORIZED only with a correct runner tag in a fully clean fake environment", async () => {
    const decision = await evaluateExecutionGate(baseInput() as never);
    expect(decision.authorized).toBe(true);
    expect(decision.checks.find((c) => c.id === "ANALYSIS_FROZEN")?.passed).toBe(true);
    expect(decision.checks.find((c) => c.id === "RUNNER_FROZEN")?.passed).toBe(true);
    expect(decision.checks.find((c) => c.id === "RUNNER_MATCHES_HEAD")?.passed).toBe(true);
    // Nothing here spawns anything; authorization is a decision, not an execution.
  });

  it("always records the freeze authority and the known source-metadata discrepancy", async () => {
    const decision = await evaluateExecutionGate(baseInput() as never);
    expect(decision.protocolFreezeAuthority).toBe("GIT_TAG");
    expect(decision.protocolFrozen).toBe(true);
    expect(decision.knownSourceMetadataNote).toMatch(/PRE_REGISTERED_NOT_FROZEN/u);
  });
});
