import type { AnalysisCoverage } from "../assurance";
import type { ObligationStatus } from "../assurance-obligation";
import {
  capabilityNegativeAbsenceCeiling,
  meetsStrength,
  type LanguageClass,
} from "../capability-adequacy";
import type { BoundCapabilityResult } from "./binding";
import type { CapabilityFinding, CapabilityResult, ProviderExecution } from "./provider";

export interface FoldedCapabilityResult {
  status: ObligationStatus;
  coverage: AnalysisCoverage;
  justification: string;
}

const hasText = (value: string): boolean => value.trim().length > 0;

const hasCompleteProvenance = (result: CapabilityResult): boolean => {
  const provenance = result.provenance;
  return (
    hasText(provenance.capabilityId) &&
    hasText(provenance.providerName) &&
    hasText(provenance.providerVersion) &&
    hasText(provenance.invokedAt) &&
    Number.isFinite(provenance.durationMs) &&
    provenance.durationMs >= 0 &&
    hasText(provenance.candidateId) &&
    hasText(provenance.diffDigest) &&
    hasText(provenance.baseRevision)
  );
};

const executionJustification = (
  execution: Exclude<ProviderExecution, { outcome: "COMPLETED" }>,
) => {
  switch (execution.outcome) {
    case "UNAVAILABLE":
      return `Provider unavailable: ${execution.detail}`;
    case "UNSUPPORTED":
      return `Provider does not support this input: ${execution.detail}`;
    case "TIMED_OUT":
      return `Provider timed out after ${execution.timeoutMs}ms.`;
    case "PROCESS_ERROR":
      return `Provider process failed${execution.exitCode === null ? "" : ` with exit code ${execution.exitCode}`}: ${execution.detail}`;
    case "MALFORMED_OUTPUT":
      return `Provider output was malformed: ${execution.detail}`;
    case "REFUSED":
      return `Provider refused execution: ${execution.detail}`;
  }
};

const coverageFor = (
  result: CapabilityResult,
  candidateLanguageClasses: LanguageClass[],
): AnalysisCoverage => {
  if (candidateLanguageClasses.length === 0) return "NOT_APPLICABLE";
  const values = candidateLanguageClasses.map((languageClass) => result.coverage[languageClass]);
  if (values.some((coverage) => coverage === undefined || coverage === "UNSUPPORTED")) {
    return "UNSUPPORTED";
  }
  if (values.some((coverage) => coverage === "PARTIAL" || coverage === "NOT_APPLICABLE")) {
    return "PARTIAL";
  }
  return "FULL";
};

const isNormalizedFinding = (finding: CapabilityFinding): boolean =>
  finding.claim === "POSITIVE_FINDING" &&
  meetsStrength(finding.strength, "LEXICAL") &&
  hasText(finding.target) &&
  hasText(finding.ruleId) &&
  hasText(finding.message);

const hasFailingSeverity = (finding: CapabilityFinding): boolean =>
  finding.severity === "HIGH" || finding.severity === "CRITICAL";

export const foldCapabilityResult = (
  boundResult: BoundCapabilityResult,
  candidateLanguageClasses: LanguageClass[],
): FoldedCapabilityResult => {
  const { result } = boundResult;
  if (result.execution.outcome !== "COMPLETED") {
    return {
      status: result.execution.outcome === "UNSUPPORTED" ? "UNSUPPORTED" : "NOT_CHECKED",
      coverage: "UNSUPPORTED",
      justification: executionJustification(result.execution),
    };
  }

  if (!hasCompleteProvenance(result)) {
    return {
      status: "NOT_CHECKED",
      coverage: "UNSUPPORTED",
      justification:
        "Completed provider output lacked required capability, version, candidate, digest, or revision provenance.",
    };
  }

  const candidateClasses = [...new Set(candidateLanguageClasses)];
  const achievedCoverage = coverageFor(result, candidateClasses);

  if (result.findings.length > 0) {
    if (!result.findings.every(isNormalizedFinding)) {
      return {
        status: "NOT_CHECKED",
        coverage: "UNSUPPORTED",
        justification: "Provider findings were not valid normalized positive evidence.",
      };
    }
    const failing = result.findings.some(hasFailingSeverity);
    return {
      status: failing ? "FAIL" : "WARN",
      coverage: achievedCoverage,
      justification: failing
        ? `Provider reported ${result.findings.length} finding(s), including HIGH or CRITICAL evidence.`
        : `Provider reported ${result.findings.length} INFO, LOW, or MEDIUM finding(s).`,
    };
  }

  if (candidateClasses.length === 0) {
    return {
      status: "NOT_REQUIRED",
      coverage: "NOT_APPLICABLE",
      justification: "The candidate contained no language class relevant to this capability.",
    };
  }

  if (result.analyzedFiles.length === 0) {
    return {
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
      justification: "Provider reported no analyzed files, so silence cannot establish absence.",
    };
  }

  if (achievedCoverage === "UNSUPPORTED") {
    return {
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
      justification: "The provider did not cover every candidate language class.",
    };
  }

  const negativeCoverage = candidateClasses.map(
    (languageClass) => result.negativeCoverage[languageClass],
  );
  const registryNegativeCeiling = capabilityNegativeAbsenceCeiling(
    result.provenance.capabilityId,
    candidateClasses,
  );
  if (registryNegativeCeiling === "UNSUPPORTED") {
    return {
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
      justification:
        "Provider silence exceeds the canonical capability registry's negative-absence authority.",
    };
  }
  if (
    negativeCoverage.some(
      (coverage) =>
        coverage === undefined || coverage === "UNSUPPORTED" || coverage === "NOT_APPLICABLE",
    )
  ) {
    return {
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
      justification:
        "The provider cannot make a negative absence claim for every candidate language class.",
    };
  }

  if (
    achievedCoverage === "PARTIAL" ||
    negativeCoverage.some((coverage) => coverage === "PARTIAL") ||
    registryNegativeCeiling === "PARTIAL"
  ) {
    return {
      status: "UNKNOWN",
      coverage: "PARTIAL",
      justification: "Provider silence came from partial analysis and cannot establish absence.",
    };
  }

  return {
    status: "PASS",
    coverage: "FULL",
    justification:
      "Provider completed with no findings and full positive and negative coverage for every candidate language class.",
  };
};
