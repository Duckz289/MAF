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

/** SECURITY HIGH (three auth-path files) — the vector that drives CRITICAL review. */
const securityHighRiskVector = deriveRiskVector({
  files: [
    "src/api/auth/session.ts",
    "src/api/auth/credential-store.ts",
    "src/domain/permission.ts",
  ],
  moduleOwnership: {
    "src/api/auth/session.ts": "api",
    "src/api/auth/credential-store.ts": "api",
    "src/domain/permission.ts": "domain",
  },
  packageOwnership: {
    "src/api/auth/session.ts": "src",
    "src/api/auth/credential-store.ts": "src",
    "src/domain/permission.ts": "src",
  },
  crossModuleEdgeCount: 2,
});

const balancedLowPlan = buildAssurancePlan(lowRiskVector, "BALANCED");
const criticalSecurePlan = buildAssurancePlan(securityHighRiskVector, "CRITICAL");

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
      expect(["DETERMINISTIC", "PENDING_CHECKER"]).toContain(result.provenance);
    }
  });

  it("marks plan-required dimensions with no checker yet as UNKNOWN, never a silent PASS", () => {
    const report = deriveQualityReport(
      reportInput({ assurancePlan: criticalSecurePlan, diffRisk: securityHighRiskVector }),
    );
    // The M8A checker now runs when SECURITY is plan-required (PASS: no secrets in this diff).
    expect(report.Security.state).toBe("PASS");
    expect(report.Security.provenance).toBe("DETERMINISTIC");
    // Network-sensitive paths were touched, so RESILIENCE is plan-required and still UNKNOWN (M10).
    expect(report.Resilience.state).toBe("UNKNOWN");
    // No performance-sensitive evidence, so PERFORMANCE is plan-exempt: NOT_REQUIRED, not UNKNOWN.
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

  it("warns on Architecture when the diff's coupling grew beyond the pre-execution estimate", () => {
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
    const report = deriveQualityReport(
      reportInput({
        assurancePlan: grownPlan,
        preExecutionRisk: lowRiskVector,
        diffRisk: grown,
      }),
    );
    expect(grownPlan.required).toContain("ARCHITECTURE");
    expect(report.Architecture.state).toBe("WARN");
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
        "src/domain/permission.ts",
      ],
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
      }),
    );
    expect(report.Security.state).toBe("PASS");
    expect(deriveTrustState("VERIFIED", report, criticalSecurePlan, true)).toBe("MERGE_ELIGIBLE");
  });

  it("caps at CORRECTNESS_VERIFIED when a gated dimension WARNs", () => {
    // ARCHITECTURE is required by this plan; make the footprint grow.
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

  it("stays at QUALITY_VERIFIED when review is required but not (yet) approved", () => {
    expect(deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, undefined)).toBe(
      "QUALITY_VERIFIED",
    );
    expect(deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, false)).toBe(
      "QUALITY_VERIFIED",
    );
  });

  it("reaches MERGE_ELIGIBLE only when a required review is actually approved", () => {
    expect(deriveTrustState("VERIFIED", reviewRequiredReport, criticalSecurePlan, true)).toBe(
      "MERGE_ELIGIBLE",
    );
  });

  it("never returns DURABLE_VERIFIED (that rung requires the M10 durability checker)", () => {
    const states = new Set<string>();
    for (const approved of [undefined, false, true]) {
      states.add(deriveTrustState("VERIFIED", passingReport, balancedLowPlan, approved));
      states.add(deriveTrustState("VERIFIED", passingReport, criticalSecurePlan, approved));
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
