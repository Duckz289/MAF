import type { AssuranceQuestionEvidence } from "./assurance-obligation";
import type { ConcernDiscoveryResult } from "./concern-discovery";

export interface DiscoveryAdequacyEvidenceInput {
  discovery: ConcernDiscoveryResult;
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
}

/**
 * Converts the discovery scope assessment into capability-stamped evidence for a first-class
 * promotion obligation. This is deliberately separate from the plan Security question:
 * planner/risk may prioritize deeper assurance, but they cannot erase an epistemic fact already
 * observed about the candidate.
 */
export const deriveDiscoveryAdequacyEvidence = (
  input: DiscoveryAdequacyEvidenceInput,
): AssuranceQuestionEvidence => {
  const assessment = input.discovery.scopeAdequacy;
  const concernsFound = assessment.conclusion === "CONCERNS_FOUND";
  const absenceEstablished = assessment.conclusion === "ABSENCE_ESTABLISHED";
  return {
    question: "DISCOVERY.MATERIAL_CONCERN_SCOPE_ADEQUACY",
    check: "DISCOVERY_ADEQUACY",
    producedBy: concernsFound ? "DISCOVERY.CONCERN_WITNESS" : "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
    outcome: concernsFound || absenceEstablished ? "PASS" : "NOT_CHECKED",
    claim: concernsFound ? "POSITIVE_FINDING" : "NEGATIVE_ABSENCE",
    completeness: assessment.completeness,
    coverage: assessment.coverage,
    strength: "STRUCTURAL",
    languageClasses: input.discovery.touchedClasses,
    analysisScope: assessment.analysisScope,
    discoveryScope: {
      unit: input.discovery.scopeAccounting.unit,
      totalRelevantUnits: input.discovery.scopeAccounting.totalRelevantUnits,
      coveredUnits:
        input.discovery.scopeAccounting.totalRelevantUnits -
        input.discovery.scopeAccounting.unsupportedUnits -
        input.discovery.scopeAccounting.unclassifiedRemainderUnits,
      residualUnits:
        input.discovery.scopeAccounting.unsupportedUnits +
        input.discovery.scopeAccounting.unclassifiedRemainderUnits,
      // The concrete scope this record claims, so the fold can verify identity rather than counts.
      unitIdentities: input.discovery.scopeAccounting.unitIdentities,
    },
    evidence: [
      ...assessment.evidence,
      concernsFound
        ? "discovery adequacy produced concrete typed work and the independent changed-unit accounting has no remainder; this PASS does not settle any typed concern"
        : absenceEstablished
          ? "the bounded change classifier established promotion-authorized claims for the complete changed-local scope; its negative PASS is limited to that scope"
          : "material-concern scope classification is explicitly incomplete; this epistemic gap is promotion-relevant independently of planner SECURITY",
    ],
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.diffDigest !== undefined ? { diffDigest: input.diffDigest } : {}),
  };
};
