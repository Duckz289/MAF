import type { AssuranceQuestionEvidence } from "./assurance-obligation";
import type { ConcernDiscoveryResult } from "./concern-discovery";
import type { ResiliencePostureResult } from "./resilience";

export interface AssuranceQuestionEvidenceInput {
  discovery: ConcernDiscoveryResult;
  resiliencePosture?: ResiliencePostureResult | undefined;
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
}

/**
 * Produces the exact evidence plan-required Security/Resilience obligations may read.
 *
 * Security uses bounded concern discovery: a clean result means only that every changed executable
 * statement in coverage was screened for the modelled material shapes. If a shape is found, the
 * plan question is still answered but the resulting typed concern must resolve separately.
 *
 * Resilience uses either code-scenario relevance (zero scenarios) or candidate-bound executed
 * scenario evidence. A broad QualityReport bucket is never consulted by this producer.
 */
export const deriveAssuranceQuestionEvidence = (
  input: AssuranceQuestionEvidenceInput,
): AssuranceQuestionEvidence[] => {
  const binding = {
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.diffDigest !== undefined ? { diffDigest: input.diffDigest } : {}),
  };
  const securityConcerns = input.discovery.concerns.filter((item) =>
    item.concern.startsWith("SECURITY."),
  );
  const foundConcern = securityConcerns.length > 0;
  const absenceEstablished = input.discovery.conclusion === "ABSENCE_ESTABLISHED";
  const evidence: AssuranceQuestionEvidence[] = [
    {
      question: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
      check: "SECURITY",
      producedBy: absenceEstablished
        ? "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER"
        : "SECURITY.CONCERN_DISCOVERY",
      outcome: foundConcern || absenceEstablished ? "PASS" : "NOT_CHECKED",
      claim: foundConcern ? "POSITIVE_FINDING" : "NEGATIVE_ABSENCE",
      completeness: input.discovery.completeness,
      coverage: input.discovery.coverage,
      strength: "STRUCTURAL",
      languageClasses: input.discovery.touchedClasses,
      analysisScope: input.discovery.analysisScope,
      evidence: [
        ...input.discovery.evidence,
        foundConcern
          ? `positive discovery refined the plan-level Security question into ${securityConcerns.length} typed concern(s), each of which must resolve independently; no absence claim is made`
          : absenceEstablished
            ? "the separate bounded classifier established an exact promotion-authorized claim for every unit not exhaustively concern-covered; this negative PASS is limited to that changed-local scope and is not detector silence"
            : "bounded positive discovery was silent over behavioural or unclassified statements; because the capability cannot prove its vocabulary complete, it emits NOT_CHECKED rather than negative PASS",
      ],
      ...binding,
    },
  ];

  if (input.resiliencePosture !== undefined) {
    const executed = input.resiliencePosture.scenarios.length > 0;
    evidence.push({
      question: executed
        ? "RESILIENCE.REQUIRED_SCENARIO_EXECUTION"
        : "RESILIENCE.MATERIAL_SCENARIO_DISCOVERY",
      check: "RESILIENCE",
      producedBy: executed
        ? "RESILIENCE.FAULT_SCENARIO_EXECUTION"
        : "RESILIENCE.CODE_RELEVANCE_SCAN",
      outcome: input.resiliencePosture.state,
      claim:
        input.resiliencePosture.state === "PASS"
          ? "NEGATIVE_ABSENCE"
          : input.resiliencePosture.state === "NOT_CHECKED"
            ? "NEGATIVE_ABSENCE"
            : "POSITIVE_FINDING",
      completeness:
        input.resiliencePosture.state === "PASS"
          ? "COMPLETE"
          : input.resiliencePosture.state === "NOT_CHECKED"
            ? "INCOMPLETE"
            : "NOT_APPLICABLE",
      coverage: input.resiliencePosture.coverage ?? "NOT_APPLICABLE",
      strength: executed ? "MEASURED" : "STRUCTURAL",
      languageClasses: input.discovery.touchedClasses,
      analysisScope: executed
        ? "candidate-bound execution of every required resilience scenario"
        : "bounded code relevance analysis for material resilience scenarios",
      evidence: input.resiliencePosture.evidence,
      ...binding,
    });
  }

  return evidence;
};
