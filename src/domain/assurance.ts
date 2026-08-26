import type { RiskDimension, RiskLevel, RiskVector } from "./risk";

/**
 * Compiles a Task Risk Profile + quality preference into an AssurancePlan: a deterministic rule
 * table, not a model call, so the same inputs always produce the same plan. Deliberately does not
 * run every check for every task — a small, low-risk change gets a small plan. Wiring these
 * checks to actual verifiers (security scanners, performance harnesses, architecture rules) is
 * later milestones' job (M7-M10); this module only decides what SHOULD be checked and why.
 */

export type QualityPreference = "FAST" | "BALANCED" | "HIGH" | "CRITICAL";

/**
 * How much of what an obligation asks about a capability was actually able to analyse.
 *
 * FULL            the capability understands the material it was given and a "no signal" verdict
 *                 is a real observation.
 * PARTIAL         some of the material is understood; the rest is outside what the capability
 *                 structurally reads, so absence of a signal is weaker than a real observation.
 * UNSUPPORTED     the material carries relevant behaviour the capability cannot read at all
 *                 (a language it does not model, an artefact class outside its scan scope).
 *                 "No signal" here is not an observation — it is the absence of a look.
 * NOT_APPLICABLE  there was nothing of this kind in the candidate to analyse.
 *
 * This is deliberately separate from the RESULT of an analysis: `no signals + UNSUPPORTED` and
 * `no signals + FULL` must never be representable as the same fact (trust invariant E).
 */
export type AnalysisCoverage = "FULL" | "PARTIAL" | "UNSUPPORTED" | "NOT_APPLICABLE";

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

/**
 * What made a check required. The distinction matters to the trust kernel, which treats these two
 * as different kinds of thing:
 *
 * CANDIDATE_EVIDENCE  a risk dimension reached its threshold on evidence about THIS candidate —
 *                     touched auth paths, resolved cross-module edges, a declared-debt delta. That
 *                     is a concern, and a concern is an obligation: if no capability can establish
 *                     the fact, the obligation stays unresolved and promotion fails closed.
 * QUALITY_PREFERENCE  nothing about the candidate raised the check; the requester asked for more
 *                     depth. A depth preference legitimately deepens checks that EXIST, but it
 *                     cannot manufacture a concern, and a preference for thoroughness must not
 *                     become a permanently unmeetable demand: where no capability exists, the gap
 *                     is disclosed on the obligation rather than blocking every candidate forever.
 *
 * Absent for a check means the plan predates this field; consumers must then treat the requirement
 * as CANDIDATE_EVIDENCE — the fail-safe reading.
 */
export type RequirementOrigin = "CANDIDATE_EVIDENCE" | "QUALITY_PREFERENCE";

export interface AssurancePlan {
  required: AssuranceCheck[];
  notRequired: AssuranceCheck[];
  /** Why each check is or is not required — always present for every check, never silent. */
  reasons: Record<AssuranceCheck, string>;
  /** What raised each REQUIRED check. Additive; absent on plans built before this field existed. */
  requirementOrigin?: Partial<Record<AssuranceCheck, RequirementOrigin>>;
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
  const origins: Partial<Record<AssuranceCheck, RequirementOrigin>> = {};
  /**
   * `evidenceRaised` is the candidate-evidence half of the condition, evaluated separately from
   * the preference half so the plan records WHICH one made the check required rather than only
   * that it is. When both hold, candidate evidence wins — it is the stronger claim.
   */
  const decide = (
    check: AssuranceCheck,
    evidenceRaised: boolean,
    preferenceRaised: boolean,
    reason: string,
  ): boolean => {
    reasons[check] = reason;
    if (evidenceRaised) origins[check] = "CANDIDATE_EVIDENCE";
    else if (preferenceRaised) origins[check] = "QUALITY_PREFERENCE";
    return evidenceRaised || preferenceRaised;
  };

  const highQuality = qualityPreference === "HIGH" || qualityPreference === "CRITICAL";
  const critical = qualityPreference === "CRITICAL";

  const decisions: Record<AssuranceCheck, boolean> = {
    // Always required: this is the trusted-verifier baseline every candidate already goes through.
    CORRECTNESS: decide("CORRECTNESS", true, false, "Baseline trusted verification always runs."),
    INTEGRATION: decide(
      "INTEGRATION",
      atLeast(dimension(riskVector, "CodeCoupling"), "MEDIUM"),
      highQuality,
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
      false,
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
      atLeast(dimension(riskVector, "DebtRisk"), "MEDIUM"),
      highQuality,
      atLeast(dimension(riskVector, "DebtRisk"), "MEDIUM")
        ? "The diff's declared-debt marker delta reaches the risk threshold."
        : highQuality
          ? `Quality preference is ${qualityPreference}.`
          : "Declared-debt delta does not reach the threshold and quality preference does not require it.",
    ),
    SECURITY: decide(
      "SECURITY",
      atLeast(dimension(riskVector, "SecuritySensitivity"), "MEDIUM"),
      critical,
      atLeast(dimension(riskVector, "SecuritySensitivity"), "MEDIUM")
        ? "Touched paths match auth/session/credential/payment-sensitive patterns."
        : critical
          ? "Quality preference is CRITICAL."
          : "No security-sensitive evidence found (path keywords and — once a diff exists — semantic code signals). Absence of signal, not evidence that security is irrelevant.",
    ),
    PERFORMANCE: decide(
      "PERFORMANCE",
      atLeast(dimension(riskVector, "PerformanceSensitivity"), "MEDIUM") ||
        atLeast(dimension(riskVector, "DataConsistencyRisk"), "MEDIUM"),
      false,
      atLeast(dimension(riskVector, "PerformanceSensitivity"), "MEDIUM")
        ? "Touched paths are performance-sensitive (query/data-heavy)."
        : atLeast(dimension(riskVector, "DataConsistencyRisk"), "MEDIUM")
          ? "Data/migration-sensitive paths were touched, which often carries performance risk too."
          : "No performance-sensitive evidence found.",
    ),
    CONCURRENCY: decide(
      "CONCURRENCY",
      atLeast(dimension(riskVector, "DataConsistencyRisk"), "HIGH"),
      false,
      atLeast(dimension(riskVector, "DataConsistencyRisk"), "HIGH")
        ? "Data-consistency risk is high; concurrent-access bugs are the dominant failure mode there."
        : "Data-consistency risk does not reach the threshold this check exists for.",
    ),
    RESILIENCE: decide(
      "RESILIENCE",
      atLeast(dimension(riskVector, "NetworkBoundaryChanges"), "MEDIUM") ||
        atLeast(dimension(riskVector, "OperationalSensitivity"), "MEDIUM"),
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
      false,
      atLeast(dimension(riskVector, "SecuritySensitivity"), "HIGH") && critical
        ? "Security sensitivity is high and quality preference is CRITICAL — a reviewer that never saw the author's reasoning must look at this candidate. Note the guarantee this buys is CONTEXT separation, not independent authority: see ReviewIndependence in review.ts."
        : "Security sensitivity or quality preference does not reach the bar for independent review.",
    ),
  };

  const required = (Object.keys(decisions) as AssuranceCheck[]).filter((check) => decisions[check]);
  const notRequired = (Object.keys(decisions) as AssuranceCheck[]).filter(
    (check) => !decisions[check],
  );
  return {
    required,
    notRequired,
    reasons: reasons as Record<AssuranceCheck, string>,
    requirementOrigin: origins,
  };
};
