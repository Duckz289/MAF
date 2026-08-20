import type { AssuranceCheck, AssurancePlan } from "./assurance";
import { riskLevelRank, type RiskVector } from "./risk";
import type { TrustState, VerificationState } from "./types";

/**
 * Quality Gate: separate from the Correctness Gate (the existing trusted-verifier pass/fail).
 * Correctness answers "does it work"; Quality answers "should it be trusted beyond that" --
 * architecture, maintainability, security/performance posture, test coverage of the change, debt.
 * Reported as a vector (one result per dimension), never collapsed into a single score, and every
 * dimension always carries evidence and provenance -- a dimension with no checker yet is UNKNOWN,
 * never a silent PASS.
 */

/**
 * UNKNOWN means "no evidence either way" (e.g. SECURITY is required but no deterministic security
 * checker exists until the M8 roadmap milestone). It is distinct from WARN ("checked, flagged,
 * worth attention") and from FAIL ("deterministic evidence says this is wrong"). UNKNOWN must
 * never be promoted to PASS -- unknown remains unknown.
 */
export type QualityCheckState = "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "NOT_REQUIRED";

/** Where a dimension's result came from. Deterministic evidence outranks model confidence. */
export type QualityProvenance = "DETERMINISTIC" | "PENDING_CHECKER";

export type QualityDimension =
  | "Correctness"
  | "Architecture"
  | "Maintainability"
  | "Security"
  | "Performance"
  | "Resilience"
  | "TestQuality"
  | "DebtDelta";

export interface QualityCheckResult {
  state: QualityCheckState;
  evidence: string[];
  provenance: QualityProvenance;
}

export type QualityReport = Record<QualityDimension, QualityCheckResult>;

/**
 * M6A trust-state ladder (see {@link TrustState} in types.ts for the authoritative definition).
 * DURABLE_VERIFIED is part of the type because the roadmap names it as part of the full model, but
 * `deriveTrustState` never returns it -- it requires production-like resilience verification,
 * which does not exist until the M10 roadmap milestone is built. Claiming it here would violate
 * "never claim capabilities/verification that don't exist". MERGE_ELIGIBLE is therefore reached
 * today via QUALITY_VERIFIED without the durability rung; when M10 lands, durability evidence
 * becomes an additional requirement on that step.
 */
export type { TrustState } from "./types";

export interface QualityReportInput {
  verificationState: VerificationState;
  verificationCommand: string | null;
  verificationExitCode: number | null | undefined;
  assurancePlan: AssurancePlan;
  preExecutionRisk: RiskVector;
  diffRisk: RiskVector;
  changedFiles: string[];
  initialModules: string[];
  moduleOwnership: Record<string, string>;
}

const requiredCheck = (plan: AssurancePlan, check: AssuranceCheck): boolean =>
  plan.required.includes(check);

const deterministic = (state: QualityCheckState, evidence: string[]): QualityCheckResult => ({
  state,
  evidence,
  provenance: "DETERMINISTIC",
});

const notRequiredResult = (plan: AssurancePlan, check: AssuranceCheck): QualityCheckResult =>
  deterministic("NOT_REQUIRED", [plan.reasons[check]]);

/**
 * A dimension the assurance plan requires but for which no deterministic checker exists yet
 * (SECURITY -> M8, PERFORMANCE -> M9, RESILIENCE -> M10). Honestly UNKNOWN -- flagged as an
 * explicit gap, never a silent PASS the plan never actually checked.
 */
const pendingCheckerResult = (milestone: string): QualityCheckResult => ({
  state: "UNKNOWN",
  evidence: [
    `required by the assurance plan; no deterministic checker exists yet (see the ${milestone} roadmap milestone)`,
  ],
  provenance: "PENDING_CHECKER",
});

const testFilePattern = /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\//iu;

const deriveCorrectness = (
  verificationState: VerificationState,
  command: string | null,
  exitCode: number | null | undefined,
): QualityCheckResult =>
  verificationState === "VERIFIED"
    ? deterministic("PASS", [
        command
          ? `verification command exited ${exitCode ?? 0}`
          : "expected-file verification succeeded",
      ])
    : deterministic("FAIL", [`trusted verification state is ${verificationState}, not VERIFIED`]);

/**
 * Not a judgment of architectural quality (that is model-review territory, see M6C) -- a
 * deterministic scope-creep detector comparing the pre-execution estimate against the actual
 * diff's ground-truth risk. A candidate that ended up more architecturally entangled than expected
 * is worth a reviewer's attention even though nothing here can say whether that entanglement is
 * *good* architecture or bad.
 */
const deriveArchitecture = (
  plan: AssurancePlan,
  preExecutionRisk: RiskVector,
  diffRisk: RiskVector,
): QualityCheckResult => {
  if (!requiredCheck(plan, "ARCHITECTURE")) return notRequiredResult(plan, "ARCHITECTURE");
  const before = preExecutionRisk.ArchitectureSensitivity.level;
  const after = diffRisk.ArchitectureSensitivity.level;
  const beforeBlast = preExecutionRisk.BlastRadius.level;
  const afterBlast = diffRisk.BlastRadius.level;
  const expanded =
    riskLevelRank[after] > riskLevelRank[before] ||
    riskLevelRank[afterBlast] > riskLevelRank[beforeBlast];
  return expanded
    ? deterministic("WARN", [
        `cross-module coupling expanded beyond the pre-execution estimate (ArchitectureSensitivity ${before} -> ${after}, BlastRadius ${beforeBlast} -> ${afterBlast})`,
      ])
    : deterministic("PASS", [
        `architectural footprint stayed within the pre-execution estimate (ArchitectureSensitivity ${after}, BlastRadius ${afterBlast})`,
      ]);
};

/** "Unnecessary change surface": files actually touched outside the pre-execution scoped modules. */
const deriveMaintainability = (
  changedFiles: string[],
  initialModules: string[],
  moduleOwnership: Record<string, string>,
): QualityCheckResult => {
  const touchedOutsideScope = changedFiles.filter((file) => {
    const module = moduleOwnership[file];
    return module !== undefined && !initialModules.includes(module);
  });
  if (touchedOutsideScope.length > 0) {
    return deterministic("WARN", [
      `${touchedOutsideScope.length} changed file(s) fall outside the pre-execution scope: ${touchedOutsideScope.slice(0, 10).join(", ")}`,
    ]);
  }
  // Files absent from moduleOwnership (typically newly created) have no scope evidence either way —
  // disclosed rather than silently counted as in-scope. Informational only; does not gate.
  const noOwnershipEvidence = changedFiles.filter((file) => moduleOwnership[file] === undefined);
  return deterministic("PASS", [
    "all changed files with known module ownership stayed within the pre-execution scope",
    ...(noOwnershipEvidence.length > 0
      ? [
          `${noOwnershipEvidence.length} changed file(s) have no module ownership evidence (likely new files) and could not be scope-checked: ${noOwnershipEvidence.slice(0, 10).join(", ")}`,
        ]
      : []),
  ]);
};

const deriveTestQuality = (changedFiles: string[]): QualityCheckResult => {
  const sourceChanges = changedFiles.filter((file) => !testFilePattern.test(file));
  const testChanges = changedFiles.filter((file) => testFilePattern.test(file));
  if (sourceChanges.length === 0) return deterministic("PASS", ["no production code changed"]);
  if (testChanges.length > 0) {
    return deterministic("PASS", [
      `${testChanges.length} test file(s) touched alongside ${sourceChanges.length} source file(s)`,
    ]);
  }
  return deterministic("WARN", [
    `${sourceChanges.length} source file(s) changed with no accompanying test file in the diff`,
  ]);
};

export const deriveQualityReport = (input: QualityReportInput): QualityReport => {
  const {
    verificationState,
    verificationCommand,
    verificationExitCode,
    assurancePlan,
    preExecutionRisk,
    diffRisk,
    changedFiles,
    initialModules,
    moduleOwnership,
  } = input;

  return {
    Correctness: deriveCorrectness(verificationState, verificationCommand, verificationExitCode),
    Architecture: deriveArchitecture(assurancePlan, preExecutionRisk, diffRisk),
    Maintainability: deriveMaintainability(changedFiles, initialModules, moduleOwnership),
    Security: !requiredCheck(assurancePlan, "SECURITY")
      ? notRequiredResult(assurancePlan, "SECURITY")
      : pendingCheckerResult("M8"),
    Performance: !requiredCheck(assurancePlan, "PERFORMANCE")
      ? notRequiredResult(assurancePlan, "PERFORMANCE")
      : pendingCheckerResult("M9"),
    Resilience: !requiredCheck(assurancePlan, "RESILIENCE")
      ? notRequiredResult(assurancePlan, "RESILIENCE")
      : pendingCheckerResult("M10"),
    TestQuality: deriveTestQuality(changedFiles),
    // DebtDelta directly reuses M5's DebtRisk evidence rather than inventing a second, overlapping
    // measure -- DebtRisk is always INSUFFICIENT_EVIDENCE today (pending the M7A roadmap
    // milestone), so this is honestly UNKNOWN, not PASS, until that real source exists. DebtDelta
    // maps to no assurance check yet, so it is informational and does not gate promotion.
    DebtDelta: {
      state: "UNKNOWN",
      evidence: diffRisk.DebtRisk.evidence,
      provenance: "PENDING_CHECKER",
    },
  };
};

/**
 * Dimensions whose result is bound to an assurance check the plan can require AND for which a
 * deterministic checker already exists in this milestone. Security/Performance/Resilience are
 * deliberately absent: their checkers arrive in M8/M9/M10, so until then those dimensions are
 * honestly reported as UNKNOWN (never PASS) but cannot gate — an unbuilt checker must not
 * deadlock MERGE_ELIGIBLE for every security-adjacent change for three milestones, and must not
 * silently pass anything either. When each checker lands, its dimension joins this table and
 * gating activates with no other change.
 */
const gatedDimensions: Partial<Record<QualityDimension, AssuranceCheck>> = {
  Correctness: "CORRECTNESS",
  Architecture: "ARCHITECTURE",
};

/**
 * A gated dimension blocks promotion unless it is exactly PASS: FAIL is deterministic evidence of
 * a problem, WARN is "checked, flagged" (e.g. architectural footprint expanded beyond estimate) --
 * neither may silently count as verified. Only NOT_REQUIRED dims, ungated informational dims
 * (Maintainability, TestQuality, DebtDelta), and not-yet-implemented dims (Security, Performance,
 * Resilience — reported UNKNOWN pending their milestone's checker) don't gate: the assurance plan
 * already decided what was required; these are the checks that can actually be run today.
 */
const gatesPromotion = (
  dimension: QualityDimension,
  result: QualityCheckResult,
  plan: AssurancePlan,
): boolean => {
  const check = gatedDimensions[dimension];
  return check !== undefined && requiredCheck(plan, check) && result.state !== "PASS";
};

/**
 * Trust-state derivation. Deterministic verification is authoritative: nothing below VERIFIED can
 * climb past PROPOSED no matter what any model says. QUALITY_VERIFIED requires every plan-gated
 * dimension to be PASS; MERGE_ELIGIBLE additionally requires independent review approval whenever
 * the plan requires INDEPENDENT_REVIEW (the author alone can never be the final judge there).
 * DURABLE_VERIFIED is unreachable until M10 -- see the TrustState doc comment.
 */
export const deriveTrustState = (
  verificationState: VerificationState,
  report: QualityReport,
  assurancePlan: AssurancePlan,
  independentReviewApproved: boolean | undefined,
): TrustState => {
  if (verificationState !== "VERIFIED") return "PROPOSED";
  const blocked = (Object.entries(report) as Array<[QualityDimension, QualityCheckResult]>).find(
    ([dimension, result]) => gatesPromotion(dimension, result, assurancePlan),
  );
  if (blocked) return "CORRECTNESS_VERIFIED";
  const reviewRequired = assurancePlan.required.includes("INDEPENDENT_REVIEW");
  if (!reviewRequired || independentReviewApproved === true) return "MERGE_ELIGIBLE";
  return "QUALITY_VERIFIED";
};
