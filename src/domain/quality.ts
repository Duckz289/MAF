import { deriveArchitectureGovernance } from "./architecture";
import {
  type AssuranceObligation,
  type ConcernEvidence,
  deriveAssuranceObligations,
  unresolvedObligations,
} from "./assurance-obligation";
import type {
  AnalysisCoverage,
  AssuranceCheck,
  AssurancePredicateIdentity,
  AssurancePlan,
  QualityPreference,
} from "./assurance";
import { discoverConcerns, type DiscoveredConcern } from "./concern-discovery";
import { deriveDebtDelta } from "./debt";
import { parseFilePatches } from "./diff-parse";
import type { PerformancePostureResult } from "./performance";
import type { ResiliencePostureResult } from "./resilience";
import type { RiskVector } from "./risk";
import { deriveSemanticSensitivity } from "./semantic-sensitivity";
import { deriveConcernEvidence } from "./concern-evidence";
import { deriveAssuranceQuestionEvidence } from "./assurance-question-evidence";
import { deriveDiscoveryAdequacyEvidence } from "./discovery-adequacy";
import { deriveSecurityPosture } from "./security";
import type { TrustState, VerificationState } from "./types";
import { normalizeVerificationSpecification } from "./verification-spec";

/**
 * Quality Gate: separate from the Correctness Gate (the existing trusted-verifier pass/fail).
 * Correctness answers "does it work"; Quality answers "should it be trusted beyond that" --
 * architecture, maintainability, security/performance posture, test coverage of the change, debt.
 * Reported as a vector (one result per dimension), never collapsed into a single score, and every
 * dimension always carries evidence and provenance -- a dimension with no checker yet is UNKNOWN,
 * never a silent PASS.
 */

/**
 * UNKNOWN means "no evidence either way" for legacy/pending dimensions. M9 uses NOT_CHECKED when
 * PERFORMANCE is required but no candidate-bound measurement exists. It is distinct from WARN ("checked,
 * flagged, worth attention") and from FAIL ("deterministic evidence says this is wrong"). UNKNOWN
 * must never be promoted to PASS -- unknown remains unknown.
 */
export type QualityCheckState =
  | "PASS"
  | "WARN"
  | "FAIL"
  | "UNKNOWN"
  | "NOT_CHECKED"
  | "NOT_REQUIRED";

/** Where a dimension's result came from. Deterministic evidence outranks model confidence. */
export type QualityProvenance = "DETERMINISTIC" | "MEASURED" | "PENDING_CHECKER";

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
  /**
   * How much of the material this dimension was asked about the producing capability could
   * actually analyse — separate from the verdict itself. `PASS` with `UNSUPPORTED` coverage and
   * `PASS` with `FULL` coverage are different facts and must stay mechanically distinguishable
   * (trust invariant E). Absent means the dimension has no coverage notion (its checker either
   * reads everything it needs or reports NOT_CHECKED).
   */
  coverage?: AnalysisCoverage;
  /** Exact predicate this result establishes; dimension equality alone grants no authority. */
  predicateIdentity?: AssurancePredicateIdentity;
}

export type QualityReport = Record<QualityDimension, QualityCheckResult>;

/**
 * M6A trust-state ladder (see {@link TrustState} in types.ts for the authoritative definition).
 * Since M10, DURABLE_VERIFIED is reachable: it is the quality-verified rung plus plan-required
 * resilience evidence — every relevant production-like failure scenario executed and passed in
 * the bounded local environment (MEASURED provenance; a heuristic relevance-empty PASS is not
 * enough). Local execution is honest about what it is: DURABLE_VERIFIED means durability was
 * checked, never that production behavior was verified.
 */
export type { TrustState } from "./types";

export interface QualityReportInput {
  verificationState: VerificationState;
  verificationCommand: string | null;
  verificationExpectedFile?: string | null;
  verificationExitCode: number | null | undefined;
  assurancePlan: AssurancePlan;
  preExecutionRisk: RiskVector;
  diffRisk: RiskVector;
  changedFiles: string[];
  initialModules: string[];
  moduleOwnership: Record<string, string>;
  /** The candidate's full unified diff patch — the M7 checkers' evidence source. */
  diffPatch: string;
  /** Candidate/digest-bound result from M9's trusted baseline/candidate measurement boundary. */
  performancePosture?: PerformancePostureResult;
  /** Candidate/digest-bound result from M10's trusted fault-injection boundary. */
  resiliencePosture?: ResiliencePostureResult;
}

const requiredCheck = (plan: AssurancePlan, check: AssuranceCheck): boolean =>
  plan.required.includes(check);

const deterministic = (
  state: QualityCheckState,
  evidence: string[],
  coverage?: AnalysisCoverage,
  predicateIdentity?: AssurancePredicateIdentity,
): QualityCheckResult => ({
  state,
  evidence,
  provenance: "DETERMINISTIC",
  ...(coverage ? { coverage } : {}),
  ...(predicateIdentity ? { predicateIdentity } : {}),
});

const notRequiredResult = (plan: AssurancePlan, check: AssuranceCheck): QualityCheckResult =>
  deterministic("NOT_REQUIRED", [plan.reasons[check]]);

const testFilePattern = /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\//iu;

const deriveCorrectness = (
  verificationState: VerificationState,
  command: string | null,
  expectedFile: string | null | undefined,
  exitCode: number | null | undefined,
): QualityCheckResult => {
  if (!command && !expectedFile) {
    return deterministic(
      "NOT_CHECKED",
      ["no verification command or expected-file assertion was configured"],
      undefined,
      "CORRECTNESS.TRUSTED_COMMAND",
    );
  }
  return verificationState === "VERIFIED"
    ? deterministic(
        "PASS",
        [
          command
            ? `verification command exited ${exitCode ?? 0}`
            : "expected-file verification succeeded",
        ],
        undefined,
        "CORRECTNESS.TRUSTED_COMMAND",
      )
    : deterministic(
        "FAIL",
        [`trusted verification state is ${verificationState}, not VERIFIED`],
        undefined,
        "CORRECTNESS.TRUSTED_COMMAND",
      );
};

/**
 * Two deterministic signals, no design opinions (those are model-review territory, see M6C):
 * (1) the M7B layering rule — a src/domain file importing outward inverts the dependency
 * direction and is FAIL; (2) the M6 scope-creep detector comparing the pre-execution estimate
 * against the actual diff's ground-truth risk — a candidate that ended up more entangled than
 * expected is worth attention (WARN) even though nothing here says whether the entanglement is
 * good or bad. A layering violation is reported as FAIL whether or not the plan required the
 * ARCHITECTURE check (a broken rule is evidence, not a preference); gating still follows the
 * plan's decision, per the gated-dimensions contract.
 */
const deriveArchitecture = (
  plan: AssurancePlan,
  _preExecutionRisk: RiskVector,
  _diffRisk: RiskVector,
  diffPatch: string,
): QualityCheckResult => {
  const governance = deriveArchitectureGovernance(diffPatch);
  const governanceEvidence = governance.evidence[0] ?? "layering governance produced no evidence";
  const domainEntries = parseFilePatches(diffPatch).filter((entry) =>
    entry.file.startsWith("src/domain/"),
  );
  const supportedEntries = domainEntries.filter(
    (entry) =>
      /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.file) &&
      !entry.binary &&
      (entry.uninspectableReasons?.length ?? 0) === 0,
  );
  const coverage: AnalysisCoverage =
    domainEntries.length === 0
      ? "NOT_APPLICABLE"
      : supportedEntries.length === domainEntries.length
        ? "FULL"
        : supportedEntries.length > 0
          ? "PARTIAL"
          : "UNSUPPORTED";
  if (governance.state === "FAIL") {
    return deterministic(
      "FAIL",
      [
        `layering violation(s) introduced by the diff: ${governance.violations[0]}`,
        ...(governance.violations.length > 1
          ? [`...and ${governance.violations.length - 1} more`]
          : []),
      ],
      coverage,
      "ARCHITECTURE.LAYER_BOUNDARY",
    );
  }
  if (!requiredCheck(plan, "ARCHITECTURE")) {
    return deterministic(
      "NOT_REQUIRED",
      [plan.reasons.ARCHITECTURE, governanceEvidence],
      coverage,
      "ARCHITECTURE.LAYER_BOUNDARY",
    );
  }
  if (coverage === "PARTIAL" || coverage === "UNSUPPORTED") {
    return deterministic(
      "UNKNOWN",
      [
        governanceEvidence,
        `${coverage} architecture coverage: the changed domain scope includes material the TypeScript/JavaScript layering checker cannot inspect`,
      ],
      coverage,
      "ARCHITECTURE.LAYER_BOUNDARY",
    );
  }
  return deterministic(
    "PASS",
    [
      governanceEvidence,
      "architecture is derived only from the captured candidate; context-window width is not evidence about candidate quality",
    ],
    coverage,
    "ARCHITECTURE.LAYER_BOUNDARY",
  );
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

/**
 * M8A: the Security dimension runs the deterministic credential-leak checker on the real diff. A
 * FAIL is reported whether or not the plan required SECURITY (a leaked secret is evidence, not a
 * preference) — and unlike other dimensions it also GATES unconditionally (see gatesPromotion):
 * plan requirements are path-keyword heuristics, and a leak into an unkeyworded path must not
 * slip past on that technicality. WARN stays plan-bound. When the check is not required, the
 * checker's evidence still rides along in NOT_REQUIRED so the result is never silent.
 *
 * Post-pilot hardening (Findings C/D): the diff is ALSO scanned for semantic sensitivity
 * (hidden-input handling, credential flow, sensitive-value exposure — see
 * semantic-sensitivity.ts). Two consequences:
 * (1) a source→sink exposure pair (a sensitive identifier routed to a raise/log/print line) is
 *     reported as WARN whether or not the plan required SECURITY — flagged, not proven, but it
 *     must not ride silently inside NOT_REQUIRED;
 * (2) when the plan did NOT require SECURITY but semantic sensitivity evidence exists, the
 *     result is UNKNOWN, not NOT_REQUIRED. "No security keyword in a path" is absence of signal,
 *     not evidence that security assurance is irrelevant; material uncertainty stays uncertain.
 *     Both UNKNOWN and NOT_CHECKED gate promotion unconditionally (see gatesPromotion): unknown
 *     must never masquerade as satisfied on the path to MERGE_ELIGIBLE.
 */
const coverageRank: Record<AnalysisCoverage, number> = {
  UNSUPPORTED: 0,
  PARTIAL: 1,
  FULL: 2,
  NOT_APPLICABLE: 3,
};

const weakerCoverage = (left: AnalysisCoverage, right: AnalysisCoverage): AnalysisCoverage =>
  coverageRank[left] <= coverageRank[right] ? left : right;

const deriveSecurity = (plan: AssurancePlan, diffPatch: string): QualityCheckResult => {
  const posture = deriveSecurityPosture(diffPatch);
  const semantic = deriveSemanticSensitivity(diffPatch);
  const discovery = discoverConcerns(diffPatch);
  // FULL on this projection is a negative-absence claim. Detector silence, missed shapes, and
  // incomplete execution-boundary recognition are not FULL. Only exhaustive concern coverage or
  // promotion-authorized bounded claims over every unit (including empty scope) may say absence
  // is meaningful here.
  const negativeProjectionCoverage: AnalysisCoverage =
    discovery.conclusion === "ABSENCE_ESTABLISHED"
      ? discovery.coverage
      : weakerCoverage(
          semantic.coverage === "NOT_APPLICABLE" ? "PARTIAL" : semantic.coverage,
          "PARTIAL",
        );
  if (posture.state === "FAIL") {
    return deterministic("FAIL", [...posture.evidence, ...posture.findings]);
  }
  if (posture.state === "NOT_CHECKED") {
    return deterministic("NOT_CHECKED", [...posture.evidence, ...posture.findings]);
  }
  const required = requiredCheck(plan, "SECURITY");
  const structural = semantic.structuralSignals;
  const behavioralUnsupported = semantic.behavioralUnsupportedFiles.length > 0;
  const coverage = semantic.coverage;
  const languageUnsupported = semantic.unsupportedLanguageFiles.length > 0;

  // Part B (hardening pass #3): a credential-literal posture WARN must NEVER collapse to
  // NOT_REQUIRED just because the plan did not require SECURITY. Findings in PRODUCTION files
  // preserve uncertainty (UNKNOWN — gates promotion until evidence addresses the flag); dummy
  // credentials confined to test/fixture files stay plan-bound WARN — fixture-normal is the
  // documented, justified resolution and must not deadlock every fixture.
  if (posture.state === "WARN" && posture.productionFlagged) {
    if (required) {
      return deterministic("WARN", [
        ...posture.evidence,
        ...posture.findings,
        ...semantic.evidence,
        "literal value(s) assigned to credential-shaped names in production files — checked and flagged; the plan requires SECURITY and no evidence resolving this flag has been produced",
      ]);
    }
    return deterministic("UNKNOWN", [
      plan.reasons.SECURITY,
      ...posture.evidence,
      ...posture.findings,
      ...semantic.evidence,
      "credential-shaped literal flagged in production files — the plan did not require SECURITY, but a flagged possible secret cannot be waived to NOT_REQUIRED without evidence addressing it; uncertainty is preserved",
    ]);
  }
  if (behavioralUnsupported) {
    // Part E: behavioral content the deterministic scanners cannot analyze (workflow/command
    // definitions) preserves uncertainty — "scanner does not support this file" is not evidence
    // of safety and must not become NOT_REQUIRED.
    if (required) {
      return deterministic("NOT_CHECKED", [
        ...semantic.evidence,
        "required by the assurance plan; added command/step definitions could not be analyzed by the deterministic security scanners",
      ]);
    }
    return deterministic("UNKNOWN", [
      plan.reasons.SECURITY,
      ...semantic.evidence,
      "behavioral content the semantic scanner cannot analyze — unsupported analysis is not evidence of safety, so uncertainty is preserved rather than manufactured as NOT_REQUIRED",
    ]);
  }
  if (required && languageUnsupported) {
    // Trust invariant C + E (hardening pass #4): the plan raised a SECURITY obligation, and the
    // only capability that addresses BEHAVIOUR — the semantic scanner — does not model the
    // idioms of at least one changed production file's language. The credential-literal posture
    // scan did run and found nothing, but it answers a different question ("is a secret written
    // into this diff?"), not the one that was asked ("does this change handle sensitive input
    // safely?"). Returning its PASS here would let capability B discharge obligation A on
    // material capability B never read. Unsupported coverage stays unresolved.
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...posture.evidence,
        ...semantic.evidence,
        `the assurance plan requires SECURITY, but the semantic capability does not model the language of ${semantic.unsupportedLanguageFiles.length} changed production file(s) (${semantic.unsupportedLanguageFiles.slice(0, 5).join(", ")}) — the credential-literal scan's PASS does not address sensitive-input or credential-flow behaviour there`,
      ],
      provenance: "DETERMINISTIC",
      coverage,
    };
  }
  if (semantic.exposurePairs.length > 0) {
    // Checked, flagged: deterministic pairing exists but is not proof of a leak. WARN blocks
    // MERGE_ELIGIBLE when SECURITY is required; when it is not required, this evidence makes
    // NOT_REQUIRED dishonest, so uncertainty is preserved instead (UNKNOWN below would be
    // unreachable — exposure pairs mean we DID check something and found a flag).
    if (!required) {
      return deterministic("UNKNOWN", [
        plan.reasons.SECURITY,
        ...semantic.evidence,
        "semantic sensitivity evidence exists but the assurance plan did not require the SECURITY check — relevance cannot be ruled out, so uncertainty is preserved rather than manufactured as NOT_REQUIRED",
      ]);
    }
    return deterministic("WARN", [
      ...posture.evidence,
      ...semantic.evidence,
      "sensitive-value exposure flagged: deterministic source→sink pairing in the diff's added code",
    ]);
  }
  if (!required) {
    if (structural.length > 0) {
      return deterministic("UNKNOWN", [
        plan.reasons.SECURITY,
        ...semantic.evidence,
        "structural semantic sensitivity evidence exists but the assurance plan did not require the SECURITY check — relevance cannot be ruled out, so uncertainty is preserved rather than manufactured as NOT_REQUIRED",
      ]);
    }
    // Part D: lexical-only hints (a vocabulary match with no binding/call/propagation shape)
    // justify cheap focused inspection, not a trust decision — they are disclosed here without
    // making SECURITY required and without blocking promotion.
    //
    // NOT_REQUIRED here means "no source raised a security obligation for this candidate", NOT
    // "the concern was checked and found irrelevant" (trust invariant D). When the semantic
    // capability could not read some of the changed material, `coverage` records that on the
    // result, so this verdict is mechanically distinguishable from the same verdict reached
    // under full coverage (trust invariant E). Coverage limits never DISCHARGE an obligation;
    // they also never manufacture one, which is what keeps assurance progressive.
    return deterministic(
      "NOT_REQUIRED",
      [
        plan.reasons.SECURITY,
        ...posture.evidence,
        ...semantic.evidence,
        semantic.signals.length > 0
          ? "only lexical (vocabulary) sensitivity hints matched — disclosed for inspection; no structural signal makes security assurance required"
          : "no path-keyword, posture, or semantic sensitivity signal matched — absence of signal, disclosed as such, not evidence that security is irrelevant",
        ...(languageUnsupported
          ? [
              "no security obligation was raised by any source; note this verdict rests on PARTIAL/UNSUPPORTED semantic coverage, so it records the absence of a raised concern, not a clean behavioural analysis",
            ]
          : []),
        ...(negativeProjectionCoverage !== "FULL" && negativeProjectionCoverage !== "NOT_APPLICABLE"
          ? [
              `claim-relative coverage for this negative projection is ${negativeProjectionCoverage}; detector silence is not FULL absence evidence`,
            ]
          : []),
      ],
      negativeProjectionCoverage,
    );
  }
  // Plan-required SECURITY with STRUCTURAL semantic evidence in the diff: the only evidence in
  // hand is the generic credential-leak posture scan, which does NOT address hidden-input
  // handling, credential flow, or flagged exposure — the semantic signals that made this check
  // required in the first place. A blind PASS here would let the requirement be "satisfied" by
  // an unrelated checker (independent-audit finding: that is exactly what happened). WARN is
  // checked-and-flagged: relevant security evidence does not exist yet, promotion is blocked
  // until it does, and no extra verifier is silently run to manufacture it.
  if (structural.length > 0) {
    return deterministic("WARN", [
      ...posture.evidence,
      ...semantic.evidence,
      "structural semantic sensitivity evidence made the SECURITY check required, and no security evidence addressing it has been produced — the generic credential-leak scan does not resolve hidden-input/credential-flow handling",
    ]);
  }
  if (
    posture.state === "PASS" &&
    negativeProjectionCoverage !== "FULL" &&
    negativeProjectionCoverage !== "NOT_APPLICABLE"
  ) {
    return deterministic(
      "NOT_CHECKED",
      [
        ...posture.evidence,
        ...posture.findings,
        ...semantic.evidence,
        `claim-relative coverage for this negative projection is ${negativeProjectionCoverage}; detector silence is preserved as NOT_CHECKED because discovery did not establish complete absence`,
      ],
      negativeProjectionCoverage,
    );
  }
  return deterministic(
    posture.state,
    [
      ...posture.evidence,
      ...posture.findings,
      ...semantic.evidence,
      ...(negativeProjectionCoverage !== "FULL" && negativeProjectionCoverage !== "NOT_APPLICABLE"
        ? [
            `claim-relative coverage for this negative projection is ${negativeProjectionCoverage}; a credential-literal/semantic no-signal result is not FULL absence evidence when discovery is incomplete or a material concern remains`,
          ]
        : []),
    ],
    negativeProjectionCoverage,
  );
};

export const deriveQualityReport = (input: QualityReportInput): QualityReport => {
  const {
    verificationState,
    verificationCommand,
    verificationExpectedFile,
    verificationExitCode,
    assurancePlan,
    preExecutionRisk,
    diffRisk,
    changedFiles,
    initialModules,
    moduleOwnership,
    diffPatch,
    performancePosture,
    resiliencePosture,
  } = input;
  // Quality is another consumer of verification authority. Normalize here as well as at the
  // API/verifier boundary so a direct domain caller cannot turn whitespace or an invalid
  // expected-file path into a correctness PASS by supplying a truthy raw string.
  const verificationSpecification = normalizeVerificationSpecification({
    ...(verificationCommand !== null && verificationCommand !== undefined
      ? { command: verificationCommand }
      : {}),
    ...(verificationExpectedFile !== null && verificationExpectedFile !== undefined
      ? { expectedFile: verificationExpectedFile }
      : {}),
  });
  const normalizedVerificationCommand =
    verificationSpecification.status === "CONFIGURED"
      ? (verificationSpecification.command ?? null)
      : null;
  const normalizedVerificationExpectedFile =
    verificationSpecification.status === "CONFIGURED"
      ? (verificationSpecification.expectedFile ?? null)
      : null;
  const normalizedVerificationState: VerificationState =
    verificationSpecification.status === "CONFIGURED" ? verificationState : "NOT_CHECKED";
  const debt = deriveDebtDelta(diffPatch);
  const debtEntries = parseFilePatches(diffPatch).filter((entry) =>
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|sh|ps1)$/u.test(entry.file),
  );
  const debtSupported = debtEntries.filter(
    (entry) =>
      /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.file) &&
      !entry.binary &&
      (entry.uninspectableReasons?.length ?? 0) === 0,
  );
  const debtCoverage: AnalysisCoverage =
    debtEntries.length === 0
      ? "NOT_APPLICABLE"
      : debtSupported.length === debtEntries.length
        ? "FULL"
        : debtSupported.length > 0
          ? "PARTIAL"
          : "UNSUPPORTED";

  return {
    Correctness: deriveCorrectness(
      normalizedVerificationState,
      normalizedVerificationCommand,
      normalizedVerificationExpectedFile,
      verificationExitCode,
    ),
    Architecture: deriveArchitecture(assurancePlan, preExecutionRisk, diffRisk, diffPatch),
    Maintainability: deriveMaintainability(changedFiles, initialModules, moduleOwnership),
    Security: deriveSecurity(assurancePlan, diffPatch),
    Performance: !requiredCheck(assurancePlan, "PERFORMANCE")
      ? notRequiredResult(assurancePlan, "PERFORMANCE")
      : performancePosture
        ? {
            state: performancePosture.state,
            evidence: performancePosture.evidence,
            provenance: performancePosture.state === "NOT_CHECKED" ? "DETERMINISTIC" : "MEASURED",
            predicateIdentity: "PERFORMANCE.MEASURED_METRIC",
          }
        : deterministic(
            "NOT_CHECKED",
            [
              "required by the assurance plan; no candidate-bound performance measurement was produced",
            ],
            undefined,
            "PERFORMANCE.MEASURED_METRIC",
          ),
    Resilience: !requiredCheck(assurancePlan, "RESILIENCE")
      ? notRequiredResult(assurancePlan, "RESILIENCE")
      : resiliencePosture
        ? {
            state:
              resiliencePosture.state === "PASS" && resiliencePosture.scenarios.length === 0
                ? "NOT_CHECKED"
                : resiliencePosture.state,
            evidence: [
              ...resiliencePosture.evidence,
              ...(resiliencePosture.state === "PASS" && resiliencePosture.scenarios.length === 0
                ? [
                    "no candidate-bound resilience scenario executed; relevance silence is not a PASS",
                  ]
                : []),
            ],
            ...(resiliencePosture.coverage ? { coverage: resiliencePosture.coverage } : {}),
            // A PASS with no executed scenarios is the deterministic relevance-empty verdict
            // (derived from the diff itself); only executed scenario evidence is MEASURED.
            provenance:
              resiliencePosture.state === "NOT_CHECKED" ||
              (resiliencePosture.state === "PASS" && resiliencePosture.scenarios.length === 0)
                ? "DETERMINISTIC"
                : "MEASURED",
          }
        : deterministic("NOT_CHECKED", [
            "required by the assurance plan; no candidate-bound resilience evidence was produced",
          ]),
    TestQuality: deriveTestQuality(changedFiles),
    // DebtDelta is the M7A declared-debt checker: deterministic from the diff's own patch. The
    // result is always reported; whether it gates promotion follows the plan's DEBT decision (the
    // plan already saw the same marker counts as DebtRisk at the diff-captured stage).
    DebtDelta: {
      state: debtCoverage === "PARTIAL" || debtCoverage === "UNSUPPORTED" ? "UNKNOWN" : debt.state,
      evidence: [
        ...debt.evidence,
        ...(debtCoverage === "PARTIAL" || debtCoverage === "UNSUPPORTED"
          ? [
              `declared-debt coverage is ${debtCoverage}; non-JavaScript/TypeScript source is not inspected`,
            ]
          : []),
      ],
      provenance: "DETERMINISTIC",
      coverage: debtCoverage,
      predicateIdentity: "DEBT.DECLARED_MARKER_DELTA",
    },
  };
};

/**
 * Trust-state derivation, folded over ASSURANCE OBLIGATIONS rather than directly over report
 * dimensions (see assurance-obligation.ts for why).
 *
 * Deterministic verification stays authoritative: nothing below VERIFIED climbs past PROPOSED, no
 * matter what any model says. Beyond that, promotion requires every MATERIAL obligation to be
 * resolved — PASS, or NOT_REQUIRED because nothing raised it. FAIL, WARN, UNKNOWN, NOT_CHECKED and
 * UNSUPPORTED all leave an obligation open and all cap the run at CORRECTNESS_VERIFIED.
 *
 * There is deliberately no gate list and no per-dimension exception table any more. The three
 * previous holes closed as consequences of the fold rather than as special cases:
 *
 * - a required check with no capability, or whose dimension is missing from the report, is an
 *   unresolved obligation because obligations are enumerated from the PLAN, not from the report;
 * - a deterministic FAIL raises its own obligation regardless of what the planner predicted;
 * - a PASS reached under UNSUPPORTED coverage is not a resolution.
 *
 * MERGE_ELIGIBLE additionally requires independent-review approval whenever the plan requires
 * INDEPENDENT_REVIEW: the author is never the sole judge there. Note what that review does and
 * does not guarantee — see {@link ReviewIndependence} in review.ts.
 */
export const deriveTrustState = (
  verificationState: VerificationState,
  report: QualityReport,
  assurancePlan: AssurancePlan,
  independentReviewApproved: boolean | undefined,
  /**
   * The diff and requested depth, for concern-level obligations. Optional so every existing caller
   * keeps working unchanged; when supplied, structurally discovered concerns and discovery-scope
   * adequacy are folded in too, so a candidate can no longer reach MERGE_ELIGIBLE because no path
   * keyword happened to match or the planner omitted Security.
   */
  concernContext?:
    | {
        diffPatch: string;
        qualityPreference?: QualityPreference | undefined;
        resiliencePosture?: ResiliencePostureResult | undefined;
        candidateId?: string | undefined;
        diffDigest?: string | undefined;
        capabilityConcerns?: DiscoveredConcern[] | undefined;
        capabilityConcernEvidence?: ConcernEvidence[] | undefined;
      }
    | undefined,
): TrustState => {
  if (verificationState !== "VERIFIED") return "PROPOSED";
  // Same candidate-bound obligation derivation the emitted ledger uses. Recomputing discovery
  // here independently would let the decision and the ledger diverge on evidence inputs.
  const obligations = assuranceObligationsFor(report, assurancePlan, concernContext);
  if (unresolvedObligations(obligations).length > 0) return "CORRECTNESS_VERIFIED";
  const resilienceRequired = assurancePlan.required.includes("RESILIENCE");
  const durabilityMeasured =
    resilienceRequired &&
    report.Resilience.provenance === "MEASURED" &&
    report.Resilience.state === "PASS";
  if (resilienceRequired && !durabilityMeasured) return "CORRECTNESS_VERIFIED";
  const reviewRequired = assurancePlan.required.includes("INDEPENDENT_REVIEW");
  if (reviewRequired && independentReviewApproved !== true) {
    return durabilityMeasured ? "DURABLE_VERIFIED" : "QUALITY_VERIFIED";
  }
  return "MERGE_ELIGIBLE";
};

/**
 * The obligation set behind a trust decision, for evidence emission and inspection. Same inputs,
 * same derivation, no separate logic — callers that want to SHOW why a candidate did or did not
 * promote read this rather than re-deriving a parallel explanation that could drift.
 */
export const assuranceObligationsFor = (
  report: QualityReport,
  assurancePlan: AssurancePlan,
  binding?: {
    candidateId?: string | undefined;
    diffDigest?: string | undefined;
    diffPatch?: string | undefined;
    qualityPreference?: QualityPreference | undefined;
    resiliencePosture?: ResiliencePostureResult | undefined;
    capabilityConcerns?: DiscoveredConcern[] | undefined;
    capabilityConcernEvidence?: ConcernEvidence[] | undefined;
  },
): AssuranceObligation[] => {
  const discovery =
    binding?.diffPatch !== undefined ? discoverConcerns(binding.diffPatch) : undefined;
  // Same typed-evidence path the trust fold uses, with the same candidate binding, so the emitted
  // explanation cannot drift from the decision it explains.
  const localConcernEvidence =
    discovery !== undefined && binding?.diffPatch !== undefined
      ? deriveConcernEvidence({
          diffPatch: binding.diffPatch,
          concerns: discovery.concerns,
          ...(binding.candidateId !== undefined ? { candidateId: binding.candidateId } : {}),
          ...(binding.diffDigest !== undefined ? { diffDigest: binding.diffDigest } : {}),
        })
      : undefined;
  const concerns = [...(discovery?.concerns ?? []), ...(binding?.capabilityConcerns ?? [])];
  const concernEvidence = [
    ...(localConcernEvidence ?? []),
    ...(binding?.capabilityConcernEvidence ?? []),
  ];
  const touchedClasses = [
    ...new Set([
      ...(discovery?.touchedClasses ?? []),
      ...(binding?.capabilityConcerns ?? []).map((concern) => concern.languageClass),
    ]),
  ];
  const assuranceQuestionEvidence =
    discovery !== undefined
      ? [
          ...deriveAssuranceQuestionEvidence({
            discovery,
            ...(binding?.resiliencePosture !== undefined
              ? { resiliencePosture: binding.resiliencePosture }
              : {}),
            ...(binding?.candidateId !== undefined ? { candidateId: binding.candidateId } : {}),
            ...(binding?.diffDigest !== undefined ? { diffDigest: binding.diffDigest } : {}),
          }),
          deriveDiscoveryAdequacyEvidence({
            discovery,
            ...(binding?.candidateId !== undefined ? { candidateId: binding.candidateId } : {}),
            ...(binding?.diffDigest !== undefined ? { diffDigest: binding.diffDigest } : {}),
          }),
        ]
      : undefined;
  return deriveAssuranceObligations({
    plan: assurancePlan,
    report,
    ...(binding?.candidateId !== undefined ? { candidateId: binding.candidateId } : {}),
    ...(binding?.diffDigest !== undefined ? { diffDigest: binding.diffDigest } : {}),
    ...(discovery ? { discovery } : {}),
    ...(concerns.length > 0
      ? {
          concerns,
          touchedClasses,
        }
      : {}),
    ...(concernEvidence.length > 0 ? { concernEvidence } : {}),
    ...(assuranceQuestionEvidence ? { assuranceQuestionEvidence } : {}),
    ...(binding?.qualityPreference !== undefined
      ? { qualityPreference: binding.qualityPreference }
      : {}),
  });
};
