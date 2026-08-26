import { describe, expect, it } from "vitest";
import {
  projectCapabilityConcerns,
  type NormalizedCapabilityEvidence,
} from "../src/application/capability-execution";
import type { AssurancePlan } from "../src/domain/assurance";
import {
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import type { CapabilityFinding } from "../src/domain/capability/provider";
import type { QualityReport } from "../src/domain/quality";

const check = (state: QualityReport["Security"]["state"]): QualityReport["Security"] => ({
  state,
  evidence: ["fixture evidence"],
  provenance: "DETERMINISTIC",
});

const report: QualityReport = {
  Correctness: check("PASS"),
  Architecture: check("NOT_REQUIRED"),
  Maintainability: check("PASS"),
  Security: check("NOT_REQUIRED"),
  Performance: check("NOT_REQUIRED"),
  Resilience: check("NOT_REQUIRED"),
  TestQuality: check("PASS"),
  DebtDelta: check("PASS"),
};

const plan: AssurancePlan = {
  required: ["CORRECTNESS"],
  notRequired: [],
  reasons: { CORRECTNESS: "fixture trusted verification" } as AssurancePlan["reasons"],
  requirementOrigin: {
    CORRECTNESS: "CANDIDATE_EVIDENCE",
  } as NonNullable<AssurancePlan["requirementOrigin"]>,
};

const finding = (severity: CapabilityFinding["severity"], ruleId: string): CapabilityFinding => ({
  target: "SECURITY.SENSITIVE_INPUT_FLOW",
  claim: "POSITIVE_FINDING",
  strength: "STRUCTURAL",
  file: "src/opaque.ts",
  line: 7,
  ruleId,
  message: "a configured rule matched a sensitive flow",
  severity,
});

const normalized = (
  findings: CapabilityFinding[],
  overrides: Partial<NormalizedCapabilityEvidence> = {},
): NormalizedCapabilityEvidence => ({
  capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
  providerName: "fixture-provider",
  providerVersion: "1.0.0",
  candidateId: "candidate-a",
  diffDigest: "sha256:candidate-a",
  baseRevision: "revision-r1",
  startedAt: "2026-08-24T00:00:00.000Z",
  completedAt: "2026-08-24T00:00:00.010Z",
  durationMs: 10,
  outcome: "COMPLETED",
  coverage: "PARTIAL",
  findingCount: findings.length,
  analyzedFileCount: 1,
  failureCategory: null,
  binding: "MATCHED",
  status: findings.some((item) => item.severity === "HIGH" || item.severity === "CRITICAL")
    ? "FAIL"
    : "WARN",
  justification: "fixture normalized result",
  findings,
  analyzedFiles: ["src/opaque.ts"],
  rulesetDigest: "sha256:rules",
  telemetry: "DISABLED",
  ...overrides,
});

const obligationsFor = (results: NormalizedCapabilityEvidence[]) => {
  const projection = projectCapabilityConcerns(results);
  const obligations = deriveAssuranceObligations({
    plan,
    report,
    candidateId: "candidate-a",
    diffDigest: "sha256:candidate-a",
    concerns: projection.concerns,
    touchedClasses: [...new Set(projection.concerns.map((item) => item.languageClass))],
    concernEvidence: projection.concernEvidence,
  });
  return { projection, obligations };
};

describe("provider evidence anti-authority bridge", () => {
  it("turns a provider-only positive finding into one exact material obligation", () => {
    const { projection, obligations } = obligationsFor([normalized([finding("HIGH", "rule-a")])]);
    const flow = obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));

    expect(projection.concerns).toHaveLength(1);
    expect(flow).toMatchObject({
      material: true,
      producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
      status: "FAIL",
      candidateId: "candidate-a",
      diffDigest: "sha256:candidate-a",
    });
    expect(unresolvedObligations(obligations)).toContainEqual(flow);
  });

  it("projects no authority from clean, unsupported, or rejected evidence", () => {
    for (const evidence of [
      normalized([], { status: "UNSUPPORTED", coverage: "UNSUPPORTED" }),
      normalized([finding("HIGH", "rule-a")], {
        binding: "REJECTED",
        outcome: "BINDING_REJECTED",
        status: "NOT_CHECKED",
      }),
    ]) {
      expect(projectCapabilityConcerns([evidence])).toEqual({
        concerns: [],
        concernEvidence: [],
      });
    }
  });

  it("rejects a finding whose capability is not authorized for its target", () => {
    const mismatched = normalized([finding("HIGH", "rule-a")], {
      capabilityId: "SECURITY.DEPENDENCY_VULNERABILITY_SCAN",
    });
    expect(projectCapabilityConcerns([mismatched])).toEqual({
      concerns: [],
      concernEvidence: [],
    });
  });

  it("cannot strengthen the obligation by reordering WARN and FAIL findings", () => {
    const forward = obligationsFor([
      normalized([finding("MEDIUM", "a-warn"), finding("HIGH", "z-fail")]),
    ]).obligations;
    const reverse = obligationsFor([
      normalized([finding("HIGH", "z-fail"), finding("MEDIUM", "a-warn")]),
    ]).obligations;
    const status = (obligations: typeof forward) =>
      obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"))?.status;

    expect(status(forward)).toBe("FAIL");
    expect(status(reverse)).toBe("FAIL");
  });
});
