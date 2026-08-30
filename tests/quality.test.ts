import { describe, expect, it } from "vitest";

import { buildAssurancePlan } from "../src/domain/assurance";
import {
  deriveQualityReport,
  deriveTrustState,
  type QualityReportInput,
} from "../src/domain/quality";
import { deriveRiskVector } from "../src/domain/risk";

/** A LOW-everything vector from a single uninteresting file. */
const lowRiskVector = deriveRiskVector({
  files: ["src/domain/widget.ts"],
  moduleOwnership: { "src/domain/widget.ts": "domain" },
  packageOwnership: { "src/domain/widget.ts": "src" },
  crossModuleEdgeCount: 0,
});

/**
 * SECURITY HIGH (three auth-path files) — the vector that drives CRITICAL review. All three files
 * sit in ONE module on purpose: CodeCoupling then stays LOW, so INTEGRATION is raised only by the
 * CRITICAL quality preference and not by evidence about the candidate. That keeps this fixture
 * about the Security/review/durability rungs. The multi-module case — where CodeCoupling raises
 * INTEGRATION from candidate evidence and the missing integration capability blocks promotion —
 * is pinned separately in tests/trust-kernel.test.ts.
 */
const securityHighRiskVector = deriveRiskVector({
  files: [
    "src/api/auth/session.ts",
    "src/api/auth/credential-store.ts",
    "src/api/auth/permission.ts",
  ],
  moduleOwnership: {
    "src/api/auth/session.ts": "api",
    "src/api/auth/credential-store.ts": "api",
    "src/api/auth/permission.ts": "api",
  },
  packageOwnership: {
    "src/api/auth/session.ts": "src",
    "src/api/auth/credential-store.ts": "src",
    "src/api/auth/permission.ts": "src",
  },
  crossModuleEdgeCount: 2,
});

const balancedLowPlan = buildAssurancePlan(lowRiskVector, "BALANCED");
const criticalSecurePlan = buildAssurancePlan(securityHighRiskVector, "CRITICAL");
const passingPerformance = {
  state: "PASS" as const,
  evidence: ["candidate-bound performance measurement stayed within threshold"],
  metrics: [],
};

/** A passing candidate-bound resilience posture (M10): every relevant scenario passed locally. */
const passingResilience = {
  state: "PASS" as const,
  evidence: ["all relevant scenario(s) executed and passed in the bounded local environment"],
  scenarios: [
    {
      scenario: "TIMEOUT" as const,
      outcome: "PASSED" as const,
      exitCode: 0,
      evidence: ["scenario command exited 0"],
    },
  ],
};

/**
 * A relevance-empty PASS (M10): deterministic heuristic absence of fault-relevant signal. Enough
 * to clear the gate, but never enough for DURABLE_VERIFIED — scenarios were not executed.
 */
const relevanceEmptyResilience = {
  state: "PASS" as const,
  evidence: ["no production-like failure scenario is relevant to this candidate"],
  scenarios: [],
};

const reportInput = (overrides: Partial<QualityReportInput> = {}): QualityReportInput => ({
  verificationState: "VERIFIED",
  verificationCommand: "npm test",
  verificationExitCode: 0,
  assurancePlan: balancedLowPlan,
  preExecutionRisk: lowRiskVector,
  diffRisk: lowRiskVector,
  changedFiles: ["src/domain/widget.ts"],
  initialModules: ["domain"],
  moduleOwnership: { "src/domain/widget.ts": "domain" },
  diffPatch: "",
  ...overrides,
});

/** A minimal unified diff adding lines to one file. */
const patchFor = (file: string, added: string[], removed: string[] = []): string =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 1,1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("deriveQualityReport", () => {
  it("always reports every one of the eight dimensions as a vector with evidence and provenance", () => {
    const report = deriveQualityReport(reportInput());
    expect(Object.keys(report).sort()).toEqual(
      [
        "Correctness",
        "Architecture",
        "Maintainability",
        "Security",
        "Performance",
        "Resilience",
        "TestQuality",
        "DebtDelta",
      ].sort(),
    );
    for (const result of Object.values(report)) {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(["DETERMINISTIC", "MEASURED", "PENDING_CHECKER"]).toContain(result.provenance);
    }
  });

  it("marks plan-required dimensions with no candidate-bound evidence as NOT_CHECKED, never a silent PASS", () => {
    const report = deriveQualityReport(
      reportInput({ assurancePlan: criticalSecurePlan, diffRisk: securityHighRiskVector }),
    );
    // The M8A checker now runs when SECURITY is plan-required (PASS: no secrets in this diff).
    expect(report.Security.state).toBe("PASS");
    expect(report.Security.provenance).toBe("DETERMINISTIC");
    // CRITICAL preference makes RESILIENCE plan-required; with no candidate-bound posture it is
    // NOT_CHECKED (M10) and blocks promotion — never silently counted as verified.
    expect(report.Resilience.state).toBe("NOT_CHECKED");
    expect(report.Resilience.provenance).toBe("DETERMINISTIC");
    // Auth API paths alone do not fabricate performance sensitivity.
    expect(report.Performance.state).toBe("NOT_REQUIRED");
  });

  it("marks plan-exempt dimensions NOT_REQUIRE with the plan's reason, not an invented verdict", () => {
    const report = deriveQualityReport(reportInput());
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(report.Security.provenance).toBe("DETERMINISTIC");
    expect(report.Security.evidence[0]).toBe(balancedLowPlan.reasons.SECURITY);
    // The checker's evidence rides along even when the check is exempt — never silent.
    expect(report.Security.evidence[1]).toContain("no credential or secret patterns");
  });

  it("fails Correctness deterministically when trusted verification did not pass", () => {
    const report = deriveQualityReport(
      reportInput({ verificationState: "FAILED", verificationExitCode: 1 }),
    );
    expect(report.Correctness.state).toBe("FAIL");
    expect(report.Correctness.provenance).toBe("DETERMINISTIC");
  });

  it("keeps Architecture invariant when only the pre-execution context estimate changes", () => {
    const grown = deriveRiskVector({
      files: ["src/api/auth/session.ts", "src/domain/widget.ts"],
      moduleOwnership: {
        "src/api/auth/session.ts": "api",
        "src/domain/widget.ts": "domain",
      },
      packageOwnership: {
        "src/api/auth/session.ts": "src",
        "src/domain/widget.ts": "src",
      },
      crossModuleEdgeCount: 3,
    });
    const grownPlan = buildAssurancePlan(grown, "BALANCED");
    const narrowContext = deriveQualityReport(
      reportInput({
        assurancePlan: grownPlan,
        preExecutionRisk: lowRiskVector,
        diffRisk: grown,
      }),
    );
    const wideContext = deriveQualityReport(
      reportInput({ assurancePlan: grownPlan, preExecutionRisk: grown, diffRisk: grown }),
    );
    expect(grownPlan.required).toContain("ARCHITECTURE");
    expect(narrowContext.Architecture).toEqual(wideContext.Architecture);
    expect(narrowContext.Architecture.state).toBe("PASS");
  });

  it("passes Architecture when the footprint stayed within the estimate", () => {
    // An architecturally-sensitive change (cross-module edges) whose actual footprint matched the
    // pre-execution estimate: required, checked, and within bounds.
    const vector = deriveRiskVector({
      files: ["src/api/auth/session.ts", "src/domain/widget.ts"],
      moduleOwnership: {
        "src/api/auth/session.ts": "api",
        "src/domain/widget.ts": "domain",
      },
      packageOwnership: {
        "src/api/auth/session.ts": "src",
        "src/domain/widget.ts": "src",
      },
      crossModuleEdgeCount: 2,
    });
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("ARCHITECTURE");
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: plan,
        preExecutionRisk: vector,
        diffRisk: vector,
        changedFiles: ["src/api/auth/session.ts", "src/domain/widget.ts"],
      }),
    );
    expect(report.Architecture.state).toBe("PASS");
  });

  it("warns (does not fail) when source changed with no test file in the diff", () => {
    const report = deriveQualityReport(reportInput());
    expect(report.TestQuality.state).toBe("WARN");
    const withTests = deriveQualityReport(
      reportInput({ changedFiles: ["src/domain/widget.ts", "tests/widget.test.ts"] }),
    );
    expect(withTests.TestQuality.state).toBe("PASS");
  });

  it("passes DebtDelta for a diff with no declared-debt markers (M7A checker)", () => {
    const report = deriveQualityReport(
      reportInput({ diffPatch: patchFor("src/domain/widget.ts", ["export const x = 1;"]) }),
    );
    expect(report.DebtDelta.state).toBe("PASS");
    expect(report.DebtDelta.provenance).toBe("DETERMINISTIC");
  });

  it("warns on DebtDelta when the diff adds declared-debt markers", () => {
    const report = deriveQualityReport(
      reportInput({
        diffPatch: patchFor("src/domain/widget.ts", [
          "// TODO: handle the edge case",
          "const y = 2;",
        ]),
      }),
    );
    expect(report.DebtDelta.state).toBe("WARN");
    expect(report.DebtDelta.evidence[0]).toContain("1 debt marker(s) added");
  });

  it("ignores debt markers in non-source files", () => {
    const report = deriveQualityReport(
      reportInput({ diffPatch: patchFor("docs/notes.md", ["TODO: fix later"]) }),
    );
    expect(report.DebtDelta.state).toBe("PASS");
  });

  it("fails Architecture deterministically when the diff introduces a domain layering violation (M7B)", () => {
    const report = deriveQualityReport(
      reportInput({
        diffPatch: patchFor("src/domain/widget.ts", [
          'import { RunService } from "../application/run-service";',
        ]),
      }),
    );
    expect(report.Architecture.state).toBe("FAIL");
    expect(report.Architecture.evidence.join(" ")).toContain("outside src/domain");
  });

  it("keeps Architecture passing for in-domain and package imports", () => {
    const report = deriveQualityReport(
      reportInput({
        diffPatch: patchFor("src/domain/widget.ts", [
          'import type { Foo } from "./types";',
          'import path from "node:path";',
        ]),
      }),
    );
    expect(report.Architecture.state).toBe("NOT_REQUIRED");
    expect(report.Architecture.evidence.join(" ")).toContain("stayed within the domain layer");
  });

  it("warns on Maintainability when changed files fall outside the pre-execution scope", () => {
    const report = deriveQualityReport(
      reportInput({
        changedFiles: ["src/infrastructure/other.ts"],
        moduleOwnership: { "src/infrastructure/other.ts": "infrastructure" },
      }),
    );
    expect(report.Maintainability.state).toBe("WARN");
  });

  it("keeps required Performance NOT_CHECKED without candidate-bound measurements", () => {
    const patch = patchFor("src/infrastructure/query.ts", [
      'await database.query("SELECT * FROM widgets");',
    ]);
    const performanceRisk = deriveRiskVector({
      files: ["src/infrastructure/query.ts"],
      moduleOwnership: { "src/infrastructure/query.ts": "infrastructure" },
      packageOwnership: { "src/infrastructure/query.ts": "src" },
      crossModuleEdgeCount: 0,
      diffPatch: patch,
    });
    const performancePlan = buildAssurancePlan(performanceRisk, "BALANCED");
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: performancePlan,
        preExecutionRisk: performanceRisk,
        diffRisk: performanceRisk,
        diffPatch: patch,
      }),
    );

    expect(performancePlan.required).toContain("PERFORMANCE");
    expect(report.Performance.state).toBe("NOT_CHECKED");
    expect(deriveTrustState("VERIFIED", report, performancePlan, undefined)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("gates on measured Performance regression without letting it erase discovery incompleteness", () => {
    const patch = patchFor("src/infrastructure/query.ts", [
      'await database.query("SELECT * FROM widgets");',
    ]);
    const performanceRisk = deriveRiskVector({
      files: ["src/infrastructure/query.ts"],
      moduleOwnership: { "src/infrastructure/query.ts": "infrastructure" },
      packageOwnership: { "src/infrastructure/query.ts": "src" },
      crossModuleEdgeCount: 0,
      diffPatch: patch,
    });
    const performancePlan = buildAssurancePlan(performanceRisk, "BALANCED");
    // The same query-heavy signal that requires PERFORMANCE also requires RESILIENCE, so the
    // promote-side fixture carries a passing resilience posture too.
    const base = {
      assurancePlan: performancePlan,
      preExecutionRisk: performanceRisk,
      diffRisk: performanceRisk,
      diffPatch: patch,
      resiliencePosture: passingResilience,
    };
    const failed = deriveQualityReport(
      reportInput({
        ...base,
        performancePosture: {
          state: "FAIL",
          evidence: ["latency regressed 30%"],
          metrics: [],
        },
      }),
    );
    const passed = deriveQualityReport(
      reportInput({
        ...base,
        performancePosture: {
          state: "PASS",
          evidence: ["latency stayed within threshold"],
          metrics: [],
        },
      }),
    );

    expect(failed.Performance.provenance).toBe("MEASURED");
    expect(deriveTrustState("VERIFIED", failed, performancePlan, undefined)).toBe(
      "CORRECTNESS_VERIFIED",
    );
    expect(
      deriveTrustState("VERIFIED", passed, performancePlan, undefined, {
        diffPatch: patch,
        qualityPreference: "BALANCED",
        resiliencePosture: passingResilience,
      }),
    ).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("deriveTrustState", () => {
  const passingReport = deriveQualityReport(reportInput());
  // Same plan as the report throughout: review required, every gated dimension PASS.
  const reviewRequiredReport = deriveQualityReport(
    reportInput({
      assurancePlan: criticalSecurePlan,
      preExecutionRisk: securityHighRiskVector,
      diffRisk: securityHighRiskVector,
      changedFiles: [
        "src/api/auth/session.ts",
        "src/api/auth/credential-store.ts",
        "src/api/auth/permission.ts",
      ],
      performancePosture: passingPerformance,
      resiliencePosture: passingResilience,
    }),
  );

  it("keeps a candidate at PROPOSED when deterministic verification is not VERIFIED", () => {
    expect(deriveTrustState("FAILED", passingReport, balancedLowPlan, true)).toBe("PROPOSED");
    // Even an approved independent review cannot lift a non-VERIFIED candidate.
    expect(deriveTrustState("PROPOSED", passingReport, criticalSecurePlan, true)).toBe("PROPOSED");
  });

  it("reaches MERGE_ELIGIBLE for a verified low-risk candidate with no review required", () => {
    expect(deriveTrustState("VERIFIED", passingReport, balancedLowPlan, undefined)).toBe(
      "MERGE_ELIGIBLE",
    );
  });

  it("caps at CORRECTNESS_VERIFIED when the plan-gated Security dimension FAILs on a leaked secret (M8)", () => {
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        performancePosture: passingPerformance,
        diffPatch: patchFor("src/config/prod.ts", ['const key = "AKIAIOSFODNN7EXAMPLE";']),
      }),
    );
    expect(report.Security.state).toBe("FAIL");
    // Even an approved independent review cannot lift a leaked secret past the gate.
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, true)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("caps at CORRECTNESS_VERIFIED when Security FAILs even if the plan did not require SECURITY (M8 review fix)", () => {
    // Plan requirements are path-keyword heuristics; a leak into an unkeyworded path must not
    // slip past the gate on that technicality — deterministic leak evidence cannot be waived.
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: balancedLowPlan,
        diffPatch: patchFor("src/util/helpers.ts", ['const key = "AKIAIOSFODNN7EXAMPLE";']),
      }),
    );
    expect(report.Security.state).toBe("FAIL");
    expect(deriveTrustState("VERIFIED", report, balancedLowPlan, undefined)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("reaches MERGE_ELIGIBLE when a plan-required Security check passes (M8)", () => {
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        performancePosture: passingPerformance,
        resiliencePosture: passingResilience,
      }),
    );
    expect(report.Security.state).toBe("PASS");
    expect(
      deriveTrustState("VERIFIED", report, criticalSecurePlan, true, {
        diffPatch: "",
        qualityPreference: "CRITICAL",
        resiliencePosture: passingResilience,
      }),
    ).toBe("MERGE_ELIGIBLE");
  });

  it("keeps a required binary Security check NOT_CHECKED and blocks promotion", () => {
    const binaryPatch = [
      "diff --git a/src/api/credential.bin b/src/api/credential.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/src/api/credential.bin",
      "GIT binary patch",
      "literal 16",
      "REVERSIBLE-BINARY-PAYLOAD",
    ].join("\n");
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        diffPatch: binaryPatch,
      }),
    );

    expect(report.Security.state).toBe("NOT_CHECKED");
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, true)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("caps at CORRECTNESS_VERIFIED when a gated dimension WARNs", () => {
    // ARCHITECTURE is required by this plan; inject a checked-and-flagged result independently of
    // the pre-execution context estimate.
    const grown = deriveRiskVector({
      files: ["src/api/auth/session.ts", "src/domain/widget.ts"],
      moduleOwnership: {
        "src/api/auth/session.ts": "api",
        "src/domain/widget.ts": "domain",
      },
      packageOwnership: {
        "src/api/auth/session.ts": "src",
        "src/domain/widget.ts": "src",
      },
      crossModuleEdgeCount: 2,
    });
    const plan = buildAssurancePlan(grown, "BALANCED");
    const report = deriveQualityReport(reportInput({ assurancePlan: plan, diffRisk: grown }));
    report.Architecture = {
      state: "WARN",
      provenance: "DETERMINISTIC",
      coverage: "FULL",
      evidence: ["candidate-bound architecture evidence flagged a material issue"],
    };
    expect(report.Architecture.state).toBe("WARN");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("caps at CORRECTNESS_VERIFIED when a plan-gated DEBT dimension WARNs (M7A)", () => {
    // Two net markers reach DebtRisk MEDIUM, so the diff-captured plan requires DEBT.
    const vector = deriveRiskVector({
      files: ["src/domain/widget.ts"],
      moduleOwnership: { "src/domain/widget.ts": "domain" },
      packageOwnership: { "src/domain/widget.ts": "src" },
      crossModuleEdgeCount: 0,
      debtMarkers: { added: 2, removed: 0 },
    });
    expect(vector.DebtRisk.level).toBe("MEDIUM");
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("DEBT");
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: plan,
        diffRisk: vector,
        diffPatch: patchFor("src/domain/widget.ts", ["// TODO: a", "// TODO: b"]),
      }),
    );
    expect(report.DebtDelta.state).toBe("WARN");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("caps at CORRECTNESS_VERIFIED when a plan-gated Architecture dimension FAILs on layering (M7B)", () => {
    const vector = deriveRiskVector({
      files: ["src/api/auth/session.ts", "src/domain/widget.ts"],
      moduleOwnership: {
        "src/api/auth/session.ts": "api",
        "src/domain/widget.ts": "domain",
      },
      packageOwnership: {
        "src/api/auth/session.ts": "src",
        "src/domain/widget.ts": "src",
      },
      crossModuleEdgeCount: 2,
    });
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("ARCHITECTURE");
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: plan,
        preExecutionRisk: vector,
        diffRisk: vector,
        diffPatch: patchFor("src/domain/widget.ts", [
          'import { RunService } from "../application/run-service";',
        ]),
      }),
    );
    expect(report.Architecture.state).toBe("FAIL");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("CORRECTNESS_VERIFIED");
  });

  it("reaches MERGE_ELIGIBLE only when a required review is actually approved", () => {
    expect(
      deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, true, {
        diffPatch: "",
        qualityPreference: "CRITICAL",
        resiliencePosture: passingResilience,
      }),
    ).toBe("MERGE_ELIGIBLE");
  });

  it("reaches DURABLE_VERIFIED when plan-required resilience passed and review is pending (M10)", () => {
    const context = {
      diffPatch: "",
      qualityPreference: "CRITICAL" as const,
      resiliencePosture: passingResilience,
    };
    expect(
      deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, undefined, context),
    ).toBe("DURABLE_VERIFIED");
    expect(
      deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, false, context),
    ).toBe("DURABLE_VERIFIED");
  });

  it("keeps relevance-empty resilience unresolved even after review approval", () => {
    // Heuristic absence of a fault-relevant signal is not proof that nothing is relevant: the
    // relevance regexes provably miss risk-relevant diffs, so DURABLE_VERIFIED (which claims
    // scenarios were actually executed and held) must require MEASURED evidence.
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        performancePosture: passingPerformance,
        resiliencePosture: relevanceEmptyResilience,
      }),
    );
    expect(report.Resilience.state).toBe("NOT_CHECKED");
    expect(report.Resilience.provenance).toBe("DETERMINISTIC");
    const context = {
      diffPatch: "",
      qualityPreference: "CRITICAL" as const,
      resiliencePosture: relevanceEmptyResilience,
    };
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, undefined, context)).toBe(
      "CORRECTNESS_VERIFIED",
    );
    // Review cannot replace measured resilience evidence.
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, true, context)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("caps at CORRECTNESS_VERIFIED when plan-required Resilience is NOT_CHECKED (M10)", () => {
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        performancePosture: passingPerformance,
      }),
    );
    expect(report.Resilience.state).toBe("NOT_CHECKED");
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, undefined)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("caps at CORRECTNESS_VERIFIED when a measured resilience scenario FAILs (M10)", () => {
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: criticalSecurePlan,
        preExecutionRisk: securityHighRiskVector,
        diffRisk: securityHighRiskVector,
        performancePosture: passingPerformance,
        resiliencePosture: {
          state: "FAIL",
          evidence: ["scenario TIMEOUT failed with exit code 1"],
          scenarios: [],
        },
      }),
    );
    expect(report.Resilience.state).toBe("FAIL");
    expect(report.Resilience.provenance).toBe("MEASURED");
    // Even an approved independent review cannot lift a failed scenario past the gate.
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, true)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("keeps DURABLE_VERIFIED unreachable when the plan does not require RESILIENCE", () => {
    // DURABLE_VERIFIED is reserved for plans that require RESILIENCE evidence AND measured it.
    // Any plan that requires INDEPENDENT_REVIEW also requires RESILIENCE (review implies CRITICAL
    // preference), so a review-requiring plan without resilience is not reachable through real
    // plans today — but a plan that skips both must never land on DURABLE_VERIFIED either way.
    const states = new Set<string>();
    for (const approved of [undefined, false, true]) {
      states.add(deriveTrustState("VERIFIED", passingReport, balancedLowPlan, approved));
    }
    expect(states.has("DURABLE_VERIFIED")).toBe(false);
  });
});

/** Sanity: the fixtures used above actually mean what the tests claim. */
describe("M6 test fixtures", () => {
  it("securityHighRiskVector has HIGH SecuritySensitivity and the CRITICAL plan requires review", () => {
    expect(securityHighRiskVector.SecuritySensitivity.level).toBe("HIGH");
    expect(criticalSecurePlan.required).toContain("INDEPENDENT_REVIEW");
    expect(criticalSecurePlan.required).toContain("SECURITY");
  });

  it("the BALANCED low-risk plan requires only correctness-class checks", () => {
    expect(balancedLowPlan.required).toContain("CORRECTNESS");
    expect(balancedLowPlan.required).not.toContain("INDEPENDENT_REVIEW");
    expect(balancedLowPlan.required).not.toContain("SECURITY");
  });
});
