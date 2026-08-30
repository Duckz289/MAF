import { describe, expect, it } from "vitest";
import { type AssuranceCheck, buildAssurancePlan } from "../src/domain/assurance";
import type { RiskLevel, RiskProvenance, RiskVector } from "../src/domain/risk";

const value = (level: RiskLevel, provenance: RiskProvenance = "DETERMINISTIC") => ({
  level,
  provenance,
  evidence: [],
});

const lowRiskVector = (): RiskVector => ({
  ReasoningDifficulty: value("LOW", "INSUFFICIENT_EVIDENCE"),
  CodeCoupling: value("LOW"),
  BlastRadius: value("LOW"),
  ArchitectureSensitivity: value("LOW"),
  DebtRisk: value("LOW", "INSUFFICIENT_EVIDENCE"),
  SecuritySensitivity: value("LOW", "HEURISTIC"),
  PerformanceSensitivity: value("LOW", "HEURISTIC"),
  OperationalSensitivity: value("LOW", "HEURISTIC"),
  NetworkBoundaryChanges: value("LOW", "HEURISTIC"),
  DataConsistencyRisk: value("LOW", "HEURISTIC"),
});

describe("buildAssurancePlan", () => {
  it("requires only the baseline for a small, low-risk, FAST-preference change", () => {
    const plan = buildAssurancePlan(lowRiskVector(), "FAST");
    expect(plan.required).toEqual(["CORRECTNESS"]);
    expect(plan.notRequired).not.toContain("CORRECTNESS");
  });

  it("explains every check, required or not", () => {
    const plan = buildAssurancePlan(lowRiskVector(), "FAST");
    const allChecks: AssuranceCheck[] = [
      "CORRECTNESS",
      "INTEGRATION",
      "ARCHITECTURE",
      "DEBT",
      "SECURITY",
      "PERFORMANCE",
      "CONCURRENCY",
      "RESILIENCE",
      "INDEPENDENT_REVIEW",
    ];
    for (const check of allChecks) {
      expect(plan.reasons[check]).toBeTruthy();
      expect(typeof plan.reasons[check]).toBe("string");
    }
    expect([...plan.required, ...plan.notRequired].sort()).toEqual([...allChecks].sort());
  });

  it("requires the DEBT check when the diff's declared-debt delta reaches MEDIUM (M7A)", () => {
    const vector = { ...lowRiskVector(), DebtRisk: value("MEDIUM", "DETERMINISTIC") };
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("DEBT");
    expect(plan.reasons.DEBT).toContain("debt");
    // LOW debt delta on a BALANCED task keeps the small plan small.
    expect(buildAssurancePlan(lowRiskVector(), "BALANCED").required).not.toContain("DEBT");
    // HIGH preference holds candidates to no-debt-added even when the delta is LOW.
    expect(buildAssurancePlan(lowRiskVector(), "HIGH").required).toContain("DEBT");
  });

  it("requires security for a security-sensitive change, matching the auth example", () => {
    const vector = { ...lowRiskVector(), SecuritySensitivity: value("HIGH") };
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("SECURITY");
    expect(plan.reasons.SECURITY).toContain("auth/session");
  });

  it("requires resilience for an operational/deploy-sensitive change, not just a network-boundary one", () => {
    const vector = { ...lowRiskVector(), OperationalSensitivity: value("HIGH") };
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("RESILIENCE");
    expect(plan.reasons.RESILIENCE).toContain("deploy");
  });

  it("requires independent review only when security is HIGH and quality is CRITICAL", () => {
    const highSecurity = { ...lowRiskVector(), SecuritySensitivity: value("HIGH") };
    expect(buildAssurancePlan(highSecurity, "BALANCED").required).not.toContain(
      "INDEPENDENT_REVIEW",
    );
    expect(buildAssurancePlan(highSecurity, "CRITICAL").required).toContain("INDEPENDENT_REVIEW");
    const lowSecurityCritical = lowRiskVector();
    expect(buildAssurancePlan(lowSecurityCritical, "CRITICAL").required).not.toContain(
      "INDEPENDENT_REVIEW",
    );
  });

  it("requires performance and concurrency checks for a database-heavy, high-consistency-risk change", () => {
    const vector = {
      ...lowRiskVector(),
      DataConsistencyRisk: value("HIGH"),
      PerformanceSensitivity: value("MEDIUM", "HEURISTIC"),
    };
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("PERFORMANCE");
    expect(plan.required).toContain("CONCURRENCY");
  });

  it("requires performance for a network-sensitive measured area without requiring it for ordinary work", () => {
    const plan = buildAssurancePlan(
      { ...lowRiskVector(), PerformanceSensitivity: value("MEDIUM", "DETERMINISTIC") },
      "BALANCED",
    );
    expect(plan.required).toContain("PERFORMANCE");
    expect(buildAssurancePlan(lowRiskVector(), "BALANCED").required).not.toContain("PERFORMANCE");
  });

  it("requires integration and architecture checks for a multi-module, coupled change", () => {
    const vector = {
      ...lowRiskVector(),
      CodeCoupling: value("MEDIUM"),
      ArchitectureSensitivity: value("MEDIUM"),
    };
    const plan = buildAssurancePlan(vector, "BALANCED");
    expect(plan.required).toContain("INTEGRATION");
    expect(plan.required).toContain("ARCHITECTURE");
  });

  it("expands scope for a CRITICAL quality preference even on a low-risk change", () => {
    const plan = buildAssurancePlan(lowRiskVector(), "CRITICAL");
    expect(plan.required).toContain("INTEGRATION");
    expect(plan.required).toContain("SECURITY");
    expect(plan.required).toContain("RESILIENCE");
  });

  it("a HIGH (not CRITICAL) preference only expands INTEGRATION and DEBT, not SECURITY or RESILIENCE, on a low-risk change", () => {
    // HIGH and CRITICAL are deliberately not treated the same everywhere: SECURITY and RESILIENCE
    // only expand for CRITICAL specifically, since forcing every HIGH-preference task through a
    // security/resilience check regardless of actual risk would defeat "a small, low-risk change
    // gets a small plan." DEBT is deterministic and cheap, so HIGH does hold it.
    const plan = buildAssurancePlan(lowRiskVector(), "HIGH");
    expect(plan.required).toContain("INTEGRATION");
    expect(plan.required).toContain("DEBT");
    expect(plan.required).not.toContain("SECURITY");
    expect(plan.required).not.toContain("RESILIENCE");
  });

  it("is deterministic — identical inputs always produce an identical plan", () => {
    const vector = lowRiskVector();
    const first = buildAssurancePlan(vector, "BALANCED");
    const second = buildAssurancePlan(vector, "BALANCED");
    expect(first).toEqual(second);
  });
});
