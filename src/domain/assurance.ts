import type { RiskDimension, RiskLevel, RiskVector } from "./risk";

/**
 * Compiles a Task Risk Profile + quality preference into an AssurancePlan: a deterministic rule
 * table, not a model call, so the same inputs always produce the same plan. Deliberately does not
 * run every check for every task — a small, low-risk change gets a small plan. Wiring these
 * checks to actual verifiers (security scanners, performance harnesses, architecture rules) is
 * later milestones' job (M7-M10); this module only decides what SHOULD be checked and why.
 */

export type QualityPreference = "FAST" | "BALANCED" | "HIGH" | "CRITICAL";

export type AssuranceCheck =
  | "CORRECTNESS"
  | "INTEGRATION"
  | "ARCHITECTURE"
  | "DEBT"
  | "SECURITY"
  | "PERFORMANCE"
  | "CONCURRENCY"
  | "RESILIENCE"
  | "INDEPENDENT_REVIEW";

export interface AssurancePlan {
  required: AssuranceCheck[];
  notRequired: AssuranceCheck[];
  /** Why each check is or is not required — always present for every check, never silent. */
  reasons: Record<AssuranceCheck, string>;
}

const atLeast = (level: RiskLevel, minimum: RiskLevel): boolean => {
  const order: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return order[level] >= order[minimum];
};

const dimension = (vector: RiskVector, name: RiskDimension): RiskLevel => vector[name].level;

export const buildAssurancePlan = (
  riskVector: RiskVector,
  qualityPreference: QualityPreference,
): AssurancePlan => {
  const reasons: Partial<Record<AssuranceCheck, string>> = {};
  const decide = (check: AssuranceCheck, required: boolean, reason: string): boolean => {
    reasons[check] = reason;
    return required;
  };

  const highQuality = qualityPreference === "HIGH" || qualityPreference === "CRITICAL";
  const critical = qualityPreference === "CRITICAL";

  const decisions: Record<AssuranceCheck, boolean> = {
    // Always required: this is the trusted-verifier baseline every candidate already goes through.
    CORRECTNESS: decide("CORRECTNESS", true, "Baseline trusted verification always runs."),
    INTEGRATION: decide(
      "INTEGRATION",
      atLeast(dimension(riskVector, "CodeCoupling"), "MEDIUM") || highQuality,
      atLeast(dimension(riskVector, "CodeCoupling"), "MEDIUM")
        ? "Multiple modules are touched; unit-level correctness alone cannot show they still work together."
        : highQuality
          ? `Quality preference is ${qualityPreference}.`
          : "Change is coupling-isolated and quality preference does not require it.",
    ),
    ARCHITECTURE: decide(
      "ARCHITECTURE",
      atLeast(dimension(riskVector, "ArchitectureSensitivity"), "MEDIUM") ||
        atLeast(dimension(riskVector, "BlastRadius"), "MEDIUM"),
      atLeast(dimension(riskVector, "ArchitectureSensitivity"), "MEDIUM")
        ? "Resolved cross-module import edges among touched files indicate an architectural boundary is involved."
        : atLeast(dimension(riskVector, "BlastRadius"), "MEDIUM")
          ? "Multiple packages are touched."
          : "Change stays within one module/package boundary.",
    ),
    // DEBT gates on the diff's declared-debt delta (the M7A checker). DebtRisk is only measurable
    // once a diff exists, so pre-execution this fires on preference alone — HIGH/CRITICAL tasks
    // hold their candidates to "no declared debt added".
    DEBT: decide(
      "DEBT",
      atLeast(dimension(riskVector, "DebtRisk"), "MEDIUM") || highQuality,
      atLeast(dimension(riskVector, "DebtRisk"), "MEDIUM")
        ? "The diff's declared-debt marker delta reaches the risk threshold."
        : highQuality
          ? `Quality preference is ${qualityPreference}.`
          : "Declared-debt delta does not reach the threshold and quality preference does not require it.",
    ),
    SECURITY: decide(
      "SECURITY",
      atLeast(dimension(riskVector, "SecuritySensitivity"), "MEDIUM") || critical,
      atLeast(dimension(riskVector, "SecuritySensitivity"), "MEDIUM")
        ? "Touched paths match auth/session/credential/payment-sensitive patterns."
        : critical
          ? "Quality preference is CRITICAL."
          : "No security-sensitive path matched and quality preference does not require it.",
    ),
    PERFORMANCE: decide(
      "PERFORMANCE",
      atLeast(dimension(riskVector, "PerformanceSensitivity"), "MEDIUM") ||
        atLeast(dimension(riskVector, "DataConsistencyRisk"), "MEDIUM"),
      atLeast(dimension(riskVector, "PerformanceSensitivity"), "MEDIUM")
        ? "Touched paths are performance-sensitive (query/data-heavy)."
        : atLeast(dimension(riskVector, "DataConsistencyRisk"), "MEDIUM")
          ? "Data/migration-sensitive paths were touched, which often carries performance risk too."
          : "No performance-sensitive evidence found.",
    ),
    CONCURRENCY: decide(
      "CONCURRENCY",
      atLeast(dimension(riskVector, "DataConsistencyRisk"), "HIGH"),
      atLeast(dimension(riskVector, "DataConsistencyRisk"), "HIGH")
        ? "Data-consistency risk is high; concurrent-access bugs are the dominant failure mode there."
        : "Data-consistency risk does not reach the threshold this check exists for.",
    ),
    RESILIENCE: decide(
      "RESILIENCE",
      atLeast(dimension(riskVector, "NetworkBoundaryChanges"), "MEDIUM") ||
        atLeast(dimension(riskVector, "OperationalSensitivity"), "MEDIUM") ||
        critical,
      atLeast(dimension(riskVector, "NetworkBoundaryChanges"), "MEDIUM")
        ? "Network-boundary-sensitive paths were touched (timeouts, retries, partial failure)."
        : atLeast(dimension(riskVector, "OperationalSensitivity"), "MEDIUM")
          ? "Operational/config-sensitive paths were touched (deploy, CI, infra) — production resilience is directly at stake."
          : critical
            ? "Quality preference is CRITICAL."
            : "No network-boundary or operational evidence found and quality preference does not require it.",
    ),
    INDEPENDENT_REVIEW: decide(
      "INDEPENDENT_REVIEW",
      atLeast(dimension(riskVector, "SecuritySensitivity"), "HIGH") && critical,
      atLeast(dimension(riskVector, "SecuritySensitivity"), "HIGH") && critical
        ? "Security sensitivity is high and quality preference is CRITICAL — the authoring model should not be the sole judge."
        : "Security sensitivity or quality preference does not reach the bar for independent review.",
    ),
  };

  const required = (Object.keys(decisions) as AssuranceCheck[]).filter((check) => decisions[check]);
  const notRequired = (Object.keys(decisions) as AssuranceCheck[]).filter(
    (check) => !decisions[check],
  );
  return { required, notRequired, reasons: reasons as Record<AssuranceCheck, string> };
};
