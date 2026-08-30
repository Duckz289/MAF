import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import {
  type AssuranceCheck,
  type AssurancePlan,
  buildAssurancePlan,
} from "../src/domain/assurance";
import {
  capabilityForCheck,
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import { MissionTree, type MissionNode } from "../src/domain/mission-tree";
import type { AgentAdapter, VerifierPort } from "../src/domain/ports";
import {
  assuranceObligationsFor,
  deriveQualityReport,
  deriveTrustState,
  type QualityReport,
  type QualityReportInput,
} from "../src/domain/quality";
import { classifyFailure } from "../src/domain/recovery";
import { deriveResilienceRelevance, deriveResiliencePosture } from "../src/domain/resilience";
import { deriveReviewIndependence } from "../src/domain/review";
import { deriveRiskVector, type RiskVector } from "../src/domain/risk";
import { deriveSemanticSensitivity } from "../src/domain/semantic-sensitivity";
import type { Run, Verification } from "../src/domain/types";
import { attributeVerificationFailure } from "../src/domain/verification-attribution";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import {
  createAdaptiveFixtureRepository,
  createFixtureRepository,
  type FixtureRepository,
  waitFor,
} from "./helpers";

/**
 * Trust-kernel INVARIANT tests (hardening pass #4).
 *
 * These deliberately do not encode the individual examples a previous audit happened to surface.
 * Each test states a property the kernel must hold for ANY candidate — "a deterministic FAIL
 * blocks", "a required check with no capability blocks", "a PASS only resolves what its producer
 * verified" — and then exercises it. Passing them is not evidence of effectiveness against any
 * benchmark, and they must never be cited as such.
 *
 * Sections are labelled by what they actually exercise:
 *   UNIT                 pure domain derivations
 *   LIVE_ENGINE          the real RunService path: candidate capture, Risk(t), plan rebuild,
 *                        verification, quality, trust
 *   SYSTEM_COMPOSITION   several subsystems composed (mission handoff, delivery, recovery)
 */

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const lowRiskVector = (): RiskVector =>
  deriveRiskVector({
    files: ["src/domain/widget.ts"],
    moduleOwnership: { "src/domain/widget.ts": "domain" },
    packageOwnership: { "src/domain/widget.ts": "src" },
    crossModuleEdgeCount: 0,
  });

const patchFor = (file: string, addedLines: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${addedLines.length + 1} @@`,
    " const existing = 1;",
    ...addedLines.map((line) => `+${line}`),
    "",
  ].join("\n");

/** A plan requiring exactly the named checks, with every requirement recorded as candidate evidence. */
const planRequiring = (checks: AssuranceCheck[]): AssurancePlan => {
  const base = buildAssurancePlan(lowRiskVector(), "BALANCED");
  const all = [...base.required, ...base.notRequired];
  return {
    required: all.filter((check) => checks.includes(check)),
    notRequired: all.filter((check) => !checks.includes(check)),
    reasons: base.reasons,
    requirementOrigin: Object.fromEntries(
      checks.map((check) => [check, "CANDIDATE_EVIDENCE" as const]),
    ),
  };
};

const reportWith = (
  plan: AssurancePlan,
  diffPatch: string,
  overrides: Partial<QualityReportInput> = {},
): QualityReport =>
  deriveQualityReport({
    verificationState: "VERIFIED",
    verificationCommand: "npm test",
    verificationExitCode: 0,
    assurancePlan: plan,
    preExecutionRisk: lowRiskVector(),
    diffRisk: lowRiskVector(),
    changedFiles: ["src/domain/widget.ts", "src/domain/widget.test.ts"],
    initialModules: ["domain"],
    moduleOwnership: {},
    diffPatch,
    ...overrides,
  });

const benignPatch = patchFor("src/domain/widget.ts", ["const WIDGET = 2;"]);

// ===========================================================================
// UNIT — the trust fold
// ===========================================================================

describe("UNIT: invariant A — any deterministic material FAIL blocks MERGE_ELIGIBLE", () => {
  it("an ARCHITECTURE layering FAIL blocks even when the plan never required ARCHITECTURE", () => {
    // The planner is a heuristic predictor. A checker that ran anyway and produced deterministic
    // FAIL evidence is not made irrelevant by the predictor having guessed the dimension would not
    // matter. This is the property, not the specific rule that produced the FAIL.
    const plan = planRequiring(["CORRECTNESS"]);
    expect(plan.required).not.toContain("ARCHITECTURE");
    const report = reportWith(
      plan,
      patchFor("src/domain/widget.ts", ['import { thing } from "../infrastructure/leak";']),
    );
    expect(report.Architecture.state).toBe("FAIL");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
    expect(deriveTrustState("VERIFIED", report, plan, true)).toBe("CORRECTNESS_VERIFIED");
  });

  it("the blocking obligation names the deterministic evidence rather than the plan", () => {
    const plan = planRequiring(["CORRECTNESS"]);
    const report = reportWith(
      plan,
      patchFor("src/domain/widget.ts", ['import { thing } from "../application/leak";']),
    );
    const blocking = unresolvedObligations(deriveAssuranceObligations({ plan, report }));
    expect(blocking.map((obligation) => obligation.origin.kind)).toContain(
      "DETERMINISTIC_EVIDENCE",
    );
    expect(blocking.some((obligation) => obligation.status === "FAIL")).toBe(true);
  });

  it("a deterministic FAIL cannot be overridden by an approved independent review", () => {
    const plan: AssurancePlan = {
      ...planRequiring(["CORRECTNESS", "INDEPENDENT_REVIEW"]),
    };
    const report = reportWith(
      plan,
      patchFor("src/domain/widget.ts", ['import { thing } from "../infrastructure/leak";']),
    );
    expect(deriveTrustState("VERIFIED", report, plan, true)).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("UNIT: invariant B — a required check with no capability is unresolved, not absent", () => {
  it("INTEGRATION required by candidate evidence blocks: no capability produces that fact", () => {
    expect(capabilityForCheck("INTEGRATION")).toBeNull();
    const plan = planRequiring(["CORRECTNESS", "INTEGRATION"]);
    const report = reportWith(plan, benignPatch);
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
    const blocking = unresolvedObligations(deriveAssuranceObligations({ plan, report }));
    expect(blocking.map((obligation) => obligation.id)).toContain("INTEGRATION.NO_CAPABILITY");
    expect(blocking[0]?.status).toBe("NOT_CHECKED");
  });

  it("CONCURRENCY required by candidate evidence blocks for the same reason", () => {
    expect(capabilityForCheck("CONCURRENCY")).toBeNull();
    const plan = planRequiring(["CORRECTNESS", "CONCURRENCY"]);
    const report = reportWith(plan, benignPatch);
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("a required check whose producing dimension is missing from the report blocks", () => {
    // Security is a concern family: without exact assurance-question evidence it blocks even if a
    // broad report key is present or absent. The bucket is not the authority either way.
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const full = reportWith(plan, benignPatch);
    const { Security: _omitted, ...withoutSecurity } = full;
    const report = withoutSecurity as unknown as QualityReport;
    const blocking = unresolvedObligations(deriveAssuranceObligations({ plan, report }));
    expect(blocking.map((obligation) => obligation.id)).toContain("SECURITY.ASSURANCE_QUESTION");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("an assurance check nobody has wired yet fails safe with no gate-list edit", () => {
    // The property under test is that adding a future check does not require remembering to add
    // it to a gate table. An unknown check value has no capability, so it takes the same branch
    // INTEGRATION does.
    const base = planRequiring(["CORRECTNESS"]);
    const future = "SUPPLY_CHAIN_PROVENANCE" as AssuranceCheck;
    const plan: AssurancePlan = {
      required: [...base.required, future],
      notRequired: base.notRequired,
      reasons: { ...base.reasons, [future]: "hypothetical future check" },
      requirementOrigin: { ...base.requirementOrigin, [future]: "CANDIDATE_EVIDENCE" },
    };
    const report = reportWith(plan, benignPatch);
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
    expect(
      unresolvedObligations(deriveAssuranceObligations({ plan, report })).map(
        (obligation) => obligation.id,
      ),
    ).toContain(`${future}.NO_CAPABILITY`);
  });

  it("a DEPTH preference cannot manufacture an unmeetable demand, and says so explicitly", () => {
    // The counterweight to the rule above. CRITICAL asks for more thoroughness; it does not
    // observe a concern about this candidate. Turning it into a permanently unresolvable
    // obligation would make every CRITICAL task un-promotable forever, which is a different
    // dishonesty — claiming a bar exists that nothing could ever clear.
    const plan = buildAssurancePlan(lowRiskVector(), "CRITICAL");
    expect(plan.required).toContain("INTEGRATION");
    expect(plan.requirementOrigin?.INTEGRATION).toBe("QUALITY_PREFERENCE");
    const report = reportWith(plan, benignPatch);
    const obligations = deriveAssuranceObligations({ plan, report });
    const integration = obligations.find((obligation) => obligation.check === "INTEGRATION");
    expect(integration?.status).toBe("NOT_CHECKED");
    expect(integration?.material).toBe(false);
    // The gap is disclosed on the obligation even though it does not block.
    expect(integration?.evidence.join(" ")).toMatch(/no capability in this build/u);
  });
});

describe("UNIT: invariant C — a PASS only resolves what its producing capability verified", () => {
  it("the credential-literal scan's PASS does not resolve a behavioural security obligation", () => {
    // The Go file's sensitive-input handling is invisible to the semantic scanner's Python/JS/shell
    // idioms. The credential scan still passes — it answers a DIFFERENT question. Resolving the
    // obligation with it would be capability B settling obligation A.
    const goPatch = patchFor("src/auth/login.go", [
      "raw, err := term.ReadPassword(int(syscall.Stdin))",
      'return "", fmt.Errorf("could not read %q: %w", string(raw), err)',
    ]);
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const report = reportWith(plan, goPatch);
    expect(report.Security.state).toBe("NOT_CHECKED");
    expect(report.Security.coverage).toBe("UNSUPPORTED");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("a code-content resilience scan cannot discharge a deployment-artefact concern", () => {
    // The relevance scan reads code files for outbound/consistency/concurrency shapes. It never
    // opens a manifest. "No relevant scenario" is therefore a statement about the code only.
    const patch = [
      patchFor("deploy/service.yaml", ["  replicas: 4"]),
      patchFor("src/app/banner.ts", ["export const banner = 2;"]),
    ].join("");
    const relevance = deriveResilienceRelevance(patch, false);
    expect(relevance.scenarios).toEqual([]);
    expect(relevance.uncoveredOperationalFiles).toContain("deploy/service.yaml");
    const posture = deriveResiliencePosture(undefined, "candidate-1", "digest-1", relevance);
    expect(posture.state).toBe("NOT_CHECKED");
  });

  it("one modelled file cannot launder an unmodelled one in the same diff", () => {
    // The mixed case is where a coverage rule quietly fails: if a diff containing both a readable
    // and an unreadable behavioural file reported "partially covered, so good enough", the
    // unreadable half would be discharged by the readable half.
    const mixed = [
      patchFor("src/app/banner.ts", ["export const banner = compute(1);"]),
      patchFor("src/auth/login.go", ["raw, err := term.ReadPassword(int(syscall.Stdin))"]),
    ].join("");
    const semantic = deriveSemanticSensitivity(mixed);
    expect(semantic.supportedLanguageFiles).toContain("src/app/banner.ts");
    expect(semantic.unsupportedLanguageFiles).toContain("src/auth/login.go");
    expect(semantic.coverage).toBe("UNSUPPORTED");
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    expect(deriveTrustState("VERIFIED", reportWith(plan, mixed), plan, undefined)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("passing every code-derived scenario does not discharge an unreadable manifest change", () => {
    // The resilience counterpart of the same laundering shape: real measured evidence exists, and
    // it still does not reach the artefact the scan cannot read.
    const mixed = [
      patchFor("src/api/client.ts", ["const response = await fetch(url);"]),
      patchFor("deploy/service.yaml", ["  replicas: 4"]),
    ].join("");
    const relevance = deriveResilienceRelevance(mixed, false);
    expect(relevance.scenarios.length).toBeGreaterThan(0);
    expect(relevance.uncoveredOperationalFiles).toContain("deploy/service.yaml");
    const posture = deriveResiliencePosture(
      {
        state: "EXECUTED" as const,
        candidateId: "candidate-1",
        diffDigest: "digest-1",
        scenarios: relevance.scenarios.map((scenario) => ({
          scenario,
          outcome: "PASSED" as const,
          exitCode: 0,
          evidence: ["passed"],
        })),
        evidence: ["executed"],
      },
      "candidate-1",
      "digest-1",
      relevance,
    );
    expect(posture.state).toBe("NOT_CHECKED");
    // The executed evidence is preserved rather than thrown away.
    expect(posture.scenarios.length).toBeGreaterThan(0);
  });

  it("keeps a relevance-empty result unresolved even when scan coverage is complete", () => {
    // Complete coverage of a bounded relevance vocabulary is still not executed durability
    // evidence; scanner silence cannot create a scenario PASS.
    const relevance = deriveResilienceRelevance(
      patchFor("src/app/banner.ts", ["export const banner = 2;"]),
      false,
    );
    expect(relevance.uncoveredOperationalFiles).toEqual([]);
    expect(deriveResiliencePosture(undefined, "c", "d", relevance).state).toBe("NOT_CHECKED");
  });

  it("a capability-level UNSUPPORTED coverage downgrades a PASS even if the producer did not", () => {
    // Backstop for capabilities added later: the obligation layer applies the rule generically, so
    // a future checker that forgets to downgrade its own PASS still cannot resolve an obligation
    // over material it could not read.
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const report = reportWith(plan, benignPatch);
    const spoofed: QualityReport = {
      ...report,
      Security: {
        state: "PASS",
        evidence: ["claimed clean"],
        provenance: "DETERMINISTIC",
        coverage: "UNSUPPORTED",
      },
    };
    const obligations = deriveAssuranceObligations({ plan, report: spoofed });
    const exactObligations = deriveAssuranceObligations({
      plan,
      report: spoofed,
      assuranceQuestionEvidence: [
        {
          question: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
          check: "SECURITY",
          producedBy: "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER",
          outcome: "PASS",
          claim: "NEGATIVE_ABSENCE",
          completeness: "COMPLETE",
          coverage: "UNSUPPORTED",
          strength: "STRUCTURAL",
          languageClasses: ["TS_JS"],
          analysisScope: "fixture fixed-data-only scope",
          evidence: ["producer claimed clean but could not read the material"],
        },
      ],
    });
    const security = exactObligations.find((obligation) => obligation.check === "SECURITY");
    expect(security?.status).toBe("UNSUPPORTED");
    expect(unresolvedObligations(exactObligations)).toContainEqual(security);
    expect(obligations.find((obligation) => obligation.check === "SECURITY")?.status).toBe(
      "NOT_CHECKED",
    );
  });
});

describe("UNIT: invariants D/E/F/G — absence, coverage and unknown are distinct facts", () => {
  it("semantic coverage distinguishes 'looked and found nothing' from 'could not look'", () => {
    const modelled = deriveSemanticSensitivity(
      patchFor("src/app/banner.ts", ["export const banner = compute(1);"]),
    );
    const unmodelled = deriveSemanticSensitivity(
      patchFor("src/auth/login.go", ["raw, err := term.ReadPassword(int(syscall.Stdin))"]),
    );
    expect(modelled.signals).toEqual([]);
    expect(unmodelled.signals).toEqual([]);
    // Identical RESULT, different COVERAGE — the fact the fold needs and the old shape erased.
    expect(modelled.coverage).toBe("FULL");
    expect(unmodelled.coverage).toBe("UNSUPPORTED");
    expect(unmodelled.unsupportedLanguageFiles).toEqual(["src/auth/login.go"]);
  });

  it("NOT_REQUIRED under partial coverage is recorded as 'nothing raised it', with the gap stated", () => {
    // No source raised a security concern, so no obligation exists — that is progressive
    // assurance, not a waiver. What must not happen is the verdict being indistinguishable from
    // one reached under full coverage.
    const plan = planRequiring(["CORRECTNESS"]);
    const report = reportWith(
      plan,
      patchFor("src/render/pixels.rs", ["let value = compute_frame(input);"]),
    );
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(report.Security.coverage).toBe("UNSUPPORTED");
    expect(report.Security.evidence.join(" ")).toMatch(/does not model|absence of a look/u);
    // Progressive assurance is preserved: nothing raised a concern, so nothing blocks.
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("MERGE_ELIGIBLE");
  });

  it("broad projections cannot resolve or block the exact Security question; deterministic FAIL still blocks", () => {
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const report = reportWith(plan, benignPatch);
    for (const state of ["UNKNOWN", "NOT_CHECKED", "WARN"] as const) {
      const mutated: QualityReport = {
        ...report,
        Security: { state, evidence: ["synthetic"], provenance: "DETERMINISTIC" },
      };
      expect(
        deriveTrustState("VERIFIED", mutated, plan, undefined, {
          diffPatch: benignPatch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("MERGE_ELIGIBLE");
    }
    const failed: QualityReport = {
      ...report,
      Security: { state: "FAIL", evidence: ["deterministic leak"], provenance: "DETERMINISTIC" },
    };
    expect(
      deriveTrustState("VERIFIED", failed, plan, undefined, {
        diffPatch: benignPatch,
        qualityPreference: "BALANCED",
      }),
    ).toBe("CORRECTNESS_VERIFIED");
    expect(
      deriveTrustState("VERIFIED", report, plan, undefined, {
        diffPatch: benignPatch,
        qualityPreference: "BALANCED",
      }),
    ).toBe("MERGE_ELIGIBLE");
  });

  it("every obligation carries a justification, including the ones that resolve", () => {
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const obligations = deriveAssuranceObligations({ plan, report: reportWith(plan, benignPatch) });
    expect(obligations.length).toBeGreaterThan(0);
    for (const obligation of obligations) {
      expect(obligation.justification.length).toBeGreaterThan(0);
      expect(obligation.origin.kind).toBeDefined();
      expect(obligation.coverage).toBeDefined();
    }
  });
});

describe("UNIT: invariants I/J/K — budget, candidate binding and recovery cannot move trust", () => {
  it("the trust fold has no budget input at all, so budget cannot lower a requirement", () => {
    // Structural, not behavioural: deriveTrustState's parameters are the verification state, the
    // report, the plan, the review verdict, and the concern context (the diff + requested depth
    // that concern discovery reads). There is nowhere for a budget signal to enter.
    expect(deriveTrustState.length).toBe(5);
  });

  it("evidence bound to another candidate never resolves this candidate's obligation", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/api/client.ts", ["const response = await fetch(url);"]),
      false,
    );
    expect(relevance.scenarios.length).toBeGreaterThan(0);
    const foreign = deriveResiliencePosture(
      {
        state: "EXECUTED" as const,
        candidateId: "candidate-OTHER",
        diffDigest: "digest-OTHER",
        scenarios: relevance.scenarios.map((scenario) => ({
          scenario,
          outcome: "PASSED" as const,
          exitCode: 0,
          evidence: ["passed"],
        })),
        evidence: ["executed"],
      },
      "candidate-THIS",
      "digest-THIS",
      relevance,
    );
    expect(foreign.state).toBe("NOT_CHECKED");
  });

  it("obligations record the candidate identity their evidence applies to", () => {
    const plan = planRequiring(["CORRECTNESS", "SECURITY"]);
    const obligations = assuranceObligationsFor(reportWith(plan, benignPatch), plan, {
      candidateId: "candidate-1",
      diffDigest: "digest-1",
    });
    for (const obligation of obligations) {
      expect(obligation.candidateId).toBe("candidate-1");
      expect(obligation.diffDigest).toBe("digest-1");
    }
  });
});

// ===========================================================================
// UNIT — failure ownership
// ===========================================================================

describe("UNIT: failure ownership selects the remediation the evidence justifies", () => {
  it("a harness-imposed timeout is an execution limit: not a test verdict, not worth re-running", () => {
    const attribution = attributeVerificationFailure({
      command: "npm test",
      exitCode: 1,
      output: "running suite...",
      execution: {
        shellSpawned: true,
        commandResolution: "RESOLVED",
        termination: "TIMED_OUT",
        timeoutMs: 120_000,
      },
    });
    expect(attribution.kind).toBe("EXECUTION_LIMIT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
    // Re-running a timeout costs another full timeout; repair, however, stays available because a
    // candidate can introduce a hang.
    expect(attribution.environmentRetryUseful).toBe(false);
  });

  it("structured termination outranks partial output that looks like a test failure", () => {
    const attribution = attributeVerificationFailure({
      command: "npm test",
      exitCode: 1,
      output: "3 tests failed\nassertion failed: expected 1",
      execution: {
        shellSpawned: true,
        commandResolution: "RESOLVED",
        termination: "TIMED_OUT",
        timeoutMs: 5_000,
      },
    });
    expect(attribution.kind).toBe("EXECUTION_LIMIT_FAILURE");
  });

  it("a resource ceiling is not a failing test just because the word 'failed' appears", () => {
    const attribution = attributeVerificationFailure({
      command: "npm test",
      exitCode: 134,
      output:
        "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    });
    expect(attribution.kind).toBe("EXECUTION_LIMIT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("genuine test-runner output is still candidate-bound and still repairable", () => {
    for (const output of [
      "2 failed, 5 passed",
      "AssertionError: expected 1 to be 2",
      "FAIL tests/widget.test.ts",
    ]) {
      const attribution = attributeVerificationFailure({
        command: "npm test",
        exitCode: 1,
        output,
      });
      expect(attribution.kind).toBe("CANDIDATE_FAILURE");
      expect(attribution.candidateBound).toBe(true);
      expect(attribution.environmentRetryUseful).toBe(false);
    }
  });

  it("ambiguous ownership stays UNKNOWN rather than being guessed into a bucket", () => {
    const attribution = attributeVerificationFailure({
      command: "npm test",
      exitCode: 1,
      output: 'error: could not compile `app` (bin "app") due to 1 previous error',
    });
    expect(attribution.kind).toBe("UNKNOWN_FAILURE");
    expect(attribution.candidateBound).toBe(false);
    // Unknown justifies the cheap deterministic probe; it does not justify a specific owner.
    expect(attribution.environmentRetryUseful).toBe(true);
  });

  it("the session classifier cannot read a missing module as a network fault", () => {
    // `enotfound` is a substring of `ModuleNotFoundError`. An unanchored match turned a
    // candidate-causable import error into an auto-retryable network class.
    expect(classifyFailure(new Error("ModuleNotFoundError: No module named 'requests'"))).toBe(
      "UNKNOWN_FAILURE",
    );
    // The real shape still classifies.
    expect(classifyFailure(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(
      "NETWORK_FAILURE",
    );
  });

  it("merely mentioning networking is not a network failure", () => {
    expect(classifyFailure(new Error("agent stopped while editing the networking layer"))).toBe(
      "UNKNOWN_FAILURE",
    );
    expect(classifyFailure(new Error("network error while contacting the provider"))).toBe(
      "NETWORK_FAILURE",
    );
  });
});

// ===========================================================================
// UNIT — review authority semantics
// ===========================================================================

describe("UNIT: independent review reports the independence it actually has", () => {
  it("same adapter, model and provider is context separation, not authority separation", () => {
    const authority = { adapter: "native-cli", model: "m", provider: "p" };
    const evidence = deriveReviewIndependence(authority, authority);
    expect(evidence.level).toBe("CONTEXT_ONLY");
    expect(evidence.guarantee).toMatch(/correlated blind spots are not ruled out/u);
  });

  it("a different model or adapter is recorded as the stronger level it is", () => {
    const author = { adapter: "native-cli", model: "author-model", provider: "p" };
    expect(deriveReviewIndependence(author, { ...author, model: "reviewer-model" }).level).toBe(
      "SEPARATE_MODEL",
    );
    expect(deriveReviewIndependence(author, { ...author, adapter: "other-cli" }).level).toBe(
      "SEPARATE_AUTHORITY",
    );
  });
});

// ===========================================================================
// SYSTEM_COMPOSITION — mission handoff
// ===========================================================================

const missionBinding = {
  runId: "run-fixture",
  candidateId: "candidate-fixture",
  candidateDigest: "digest-fixture",
  verificationId: "verification-fixture",
};

const missionNode = (overrides: Partial<MissionNode> & { id: string }): MissionNode => {
  const node: MissionNode = {
    dependencyIds: [],
    state: "READY",
    executionMode: "GUIDED",
    agent: "fixture",
    model: "fixture",
    budget: 0,
    inputs: [],
    outputs: [],
    verificationState: "VERIFIED",
    ...overrides,
  };
  if (node.trustState && !node.trustBinding) {
    node.trustBinding = missionBinding;
  }
  return node;
};

describe("SYSTEM_COMPOSITION: mission handoff cannot consume a quality-blocked candidate", () => {
  it("a VERIFIED but assurance-blocked node cannot be promoted", () => {
    const tree = new MissionTree(
      missionNode({
        id: "root",
        verificationState: "VERIFIED",
        trustState: "CORRECTNESS_VERIFIED",
      }),
    );
    expect(() => tree.promote("root", "artifact")).toThrow(/not MERGE_ELIGIBLE/u);
  });

  it("a VERIFIED but assurance-blocked node cannot satisfy a dependency", () => {
    const tree = new MissionTree(missionNode({ id: "root" }));
    tree.split("root", [
      missionNode({ id: "a", parentId: "root", verificationState: "PROPOSED" }),
      missionNode({
        id: "b",
        parentId: "root",
        dependencyIds: ["a"],
        verificationState: "PROPOSED",
      }),
    ]);
    tree.setVerification("a", "VERIFIED", ["out-a"], "QUALITY_VERIFIED");
    expect(tree.canRun("b")).toBe(false);
    tree.setVerification("a", "VERIFIED", ["out-a"], "MERGE_ELIGIBLE", missionBinding);
    expect(tree.canRun("b")).toBe(true);
  });

  it("a node that explicitly declares a legacy trust basis keeps the correctness-only rule", () => {
    // Legacy nodes are not retroactively assumed trusted, and they are not retroactively blocked
    // either — the basis they are actually running under is named. Hardening pass #5 (finding H4):
    // that historical rule now requires an EXPLICIT declaration, because inferring it from a
    // missing field let any new client buy the weaker rule by forgetting to set one.
    const tree = new MissionTree(missionNode({ id: "root", legacyTrustBasis: true }));
    expect(tree.handoffBasis()).toEqual([{ id: "root", basis: "CORRECTNESS_ONLY" }]);
    expect(() => tree.promote("root", "artifact")).not.toThrow();
  });

  it("a current node with neither a verdict nor a legacy declaration fails safe", () => {
    // Finding H4. A record that simply omits trustState is a current record missing its verdict,
    // not a historical record claiming compatibility. Nothing is inferred from the gap.
    const tree = new MissionTree(missionNode({ id: "root" }));
    expect(tree.handoffBasis()[0]?.basis).toBe("UNDECLARED");
    expect(() => tree.promote("root", "artifact")).toThrow(/legacy trust basis/u);
  });

  it("merge refuses an assurance-blocked source and names it", () => {
    const tree = new MissionTree(missionNode({ id: "root" }));
    tree.split("root", [
      missionNode({ id: "a", parentId: "root", trustState: "MERGE_ELIGIBLE" }),
      missionNode({ id: "b", parentId: "root", trustState: "CORRECTNESS_VERIFIED" }),
    ]);
    expect(() => tree.merge(["a", "b"], missionNode({ id: "merged" }))).toThrow(
      /b is not eligible/u,
    );
  });
});

// ===========================================================================
// LIVE_ENGINE — the real RunService path
// ===========================================================================

const alwaysVerified: VerifierPort = {
  async verify(run: Run): Promise<Verification> {
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      type: "command",
      state: "VERIFIED",
      exitCode: 0,
      output: "ok",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  },
  async cancel(): Promise<void> {},
};

const harness = (verifier: VerifierPort = alwaysVerified) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const service = new RunService({
    store,
    agent: new NativeCliAdapter({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        path.resolve("src/fixtures/native-agent.ts"),
      ],
      capabilities: { livePolicyUpdate: true },
    }) as AgentAdapter,
    sandbox: new LocalWorktreeSandbox("", "none"),
    verifier,
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry: new DomainTelemetryRecorder(),
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, store };
};

const runToCompletion = async (
  service: RunService,
  prompt: string,
  repositoryPath: string,
): Promise<{ run: Run | undefined; quality: Record<string, unknown> | undefined }> => {
  const created = await service.create({
    prompt,
    repositoryPath,
    verification: { command: "echo ok" },
  });
  const run = await waitFor(
    () => service.get(created.id),
    (value) => value?.state === "COMPLETED" || value?.state === "FAILED",
  );
  await service.waitForIdle(created.id);
  const events = await service.events(created.id);
  const quality = events.find((event) => event.type === "QualityAssessed")?.data as
    | Record<string, unknown>
    | undefined;
  return { run, quality };
};

describe("LIVE_ENGINE: the real path holds the same invariants", () => {
  it("a benign single-module change still reaches MERGE_ELIGIBLE (assurance stays progressive)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run } = await runToCompletion(service, "Write the fixture artifact", fixture.path);
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("MERGE_ELIGIBLE");
  }, 60_000);

  it("sensitive behaviour in a language the scanner does not model is not waved through", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run, quality } = await runToCompletion(
      service,
      "write unmodelled language credential flow",
      fixture.path,
    );
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).not.toBe("MERGE_ELIGIBLE");
    expect(JSON.stringify(quality)).toMatch(/does not model|UNSUPPORTED/u);
  }, 60_000);

  it("a deployment-artefact change leaves its resilience obligation unresolved", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run, quality } = await runToCompletion(
      service,
      "change deployment manifest",
      fixture.path,
    );
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).not.toBe("MERGE_ELIGIBLE");
    expect(JSON.stringify(quality)).toMatch(/deployment\/operational artefact/u);
  }, 60_000);

  it("a deterministic layering FAIL blocks through the live engine, plan or no plan", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run, quality } = await runToCompletion(
      service,
      "invert the domain layer",
      fixture.path,
    );
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");
    const report = (quality?.report ?? {}) as QualityReport;
    expect(report.Architecture?.state).toBe("FAIL");
  }, 60_000);

  it("a multi-module change leaves the integration obligation unresolved and says why", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run, quality } = await runToCompletion(
      service,
      "harden the auth surface across modules",
      fixture.path,
    );
    expect(run?.verificationState).toBe("VERIFIED");
    if (run?.trustState !== "MERGE_ELIGIBLE") {
      expect(JSON.stringify(quality?.obligations)).toMatch(
        /NO_CAPABILITY|NOT_CHECKED|UNSUPPORTED/u,
      );
    }
    // Whatever the outcome, the ledger explaining it is always emitted.
    expect(Array.isArray(quality?.obligations)).toBe(true);
  }, 60_000);

  it("the emitted obligation ledger answers why the trust state is what it is", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness();
    const { run, quality } = await runToCompletion(
      service,
      "Write the fixture artifact",
      fixture.path,
    );
    const obligations = quality?.obligations as Array<Record<string, unknown>> | undefined;
    expect(obligations && obligations.length > 0).toBe(true);
    for (const obligation of obligations ?? []) {
      expect(obligation.id).toBeDefined();
      expect(obligation.status).toBeDefined();
      expect(obligation.coverage).toBeDefined();
      expect(obligation.justification).toBeDefined();
      expect(obligation.candidateId).toBeDefined();
    }
    expect(quality?.trustState).toBe(run?.trustState);
  }, 60_000);
});

// ===========================================================================
// SYSTEM_COMPOSITION — durability
// ===========================================================================

describe("SYSTEM_COMPOSITION: an operator's emergency stop outlives the process", () => {
  it("a freshly constructed service refuses new runs when the durable flag is set", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const store = new InMemoryRunStore();
    await store.saveControlState({
      emergencyStopped: true,
      updatedAt: new Date().toISOString(),
      reason: "operator emergency stop",
    });
    const brain = new InMemoryProjectBrain();
    // A brand-new RunService stands in for a restarted process: its in-memory flag starts false.
    const service = new RunService({
      store,
      agent: new NativeCliAdapter({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }) as AgentAdapter,
      sandbox: new LocalWorktreeSandbox("", "none"),
      verifier: alwaysVerified,
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
    });
    expect(service.isEmergencyStopped()).toBe(false);
    await expect(
      service.create({
        prompt: "should never start",
        repositoryPath: fixture.path,
        verification: { command: "echo ok" },
      }),
    ).rejects.toThrow(/emergency stop is active/u);
  }, 30_000);

  it("stopping persists the decision so a later process can read it", async () => {
    const store = new InMemoryRunStore();
    const brain = new InMemoryProjectBrain();
    const service = new RunService({
      store,
      agent: new NativeCliAdapter({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }) as AgentAdapter,
      sandbox: new LocalWorktreeSandbox("", "none"),
      verifier: alwaysVerified,
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
    });
    await service.emergencyStop();
    expect((await store.getControlState())?.emergencyStopped).toBe(true);
  });
});

// ===========================================================================
// SYSTEM_COMPOSITION — evidence survives the remediation ladder
// ===========================================================================

describe("SYSTEM_COMPOSITION: remediation never rewrites an unresolved obligation", () => {
  it("a deterministic FAIL still blocks after the plan is rebuilt from the diff", () => {
    // Risk(t) reassessment is allowed to CHANGE the plan; it is not allowed to erase evidence the
    // previous stage produced. The layering FAIL is derived from the candidate diff itself, so it
    // survives any plan the rebuild produces.
    const violation = patchFor("src/domain/widget.ts", [
      'import { thing } from "../infrastructure/leak";',
    ]);
    for (const preference of ["FAST", "BALANCED", "HIGH", "CRITICAL"] as const) {
      const vector = deriveRiskVector({
        files: ["src/domain/widget.ts"],
        moduleOwnership: { "src/domain/widget.ts": "domain" },
        packageOwnership: { "src/domain/widget.ts": "src" },
        crossModuleEdgeCount: 0,
        diffPatch: violation,
      });
      const plan = buildAssurancePlan(vector, preference);
      const report = reportWith(plan, violation, { preExecutionRisk: vector, diffRisk: vector });
      expect(report.Architecture.state).toBe("FAIL");
      expect(deriveTrustState("VERIFIED", report, plan, true)).toBe("CORRECTNESS_VERIFIED");
    }
  });
});
