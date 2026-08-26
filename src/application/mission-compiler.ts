import { deterministicDigest } from "../domain/deterministic-identity";
import {
  type AuthorityCapability,
  defaultMissionAuthority,
  type MissionCompilationRequest,
  type MissionContract,
} from "../domain/mission";

const boundedList = (label: string, values: string[] | undefined, maximum: number): string[] => {
  const result = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  if (result.length > maximum || result.some((value) => value.length > 2_000)) {
    throw new Error(`${label} exceeds the bounded mission-compilation limit`);
  }
  return result;
};

/**
 * Deterministic intent normalization. It never calls a model and never derives authority from
 * prose: raw prompt text remains objective content, while MAF policy owns the authority contract.
 */
export const compileMissionContract = (request: MissionCompilationRequest): MissionContract => {
  const objective = request.objective.trim();
  if (objective.length === 0 || objective.length > 20_000) {
    throw new Error("Mission objective must contain between 1 and 20,000 characters");
  }
  const paths = boundedList("Mission scope", request.scopePaths, 100);
  const exclusions = boundedList("Mission exclusions", request.scopeExclusions, 100);
  const constraints = boundedList("Mission constraints", request.constraints, 100);
  const acceptanceCriteria = boundedList(
    "Mission acceptance criteria",
    request.acceptanceCriteria,
    100,
  );
  const expectedEvidence = boundedList("Mission expected evidence", request.expectedEvidence, 100);
  const skills = boundedList("Mission skills", request.skillIds, 32);
  const requestedAuthority = [...new Set(request.requestedAuthority ?? [])];
  // MAF owns the executable baseline. A user request is preserved for audit, but it can neither
  // add dangerous authority nor make the contract contradict the sandbox tools MAF will supply.
  const effectiveGranted = [...defaultMissionAuthority.granted];
  const denied = [
    ...new Set([
      ...defaultMissionAuthority.denied,
      ...requestedAuthority.filter((capability) => !effectiveGranted.includes(capability)),
    ]),
  ];
  const criteriaStatus = request.acceptanceCriteriaAmbiguous
    ? "AMBIGUOUS"
    : acceptanceCriteria.length > 0
      ? "EXPLICIT"
      : "UNSPECIFIED";
  const ambiguities = [
    ...(criteriaStatus === "UNSPECIFIED"
      ? [
          "Acceptance criteria were not explicitly supplied; verification requirements remain separate evidence expectations.",
        ]
      : []),
    ...(criteriaStatus === "AMBIGUOUS"
      ? ["Acceptance criteria remain ambiguous and were not converted into deterministic truth."]
      : []),
    ...(paths.length === 0
      ? [
          "Repository-relative scope paths were not explicitly supplied; scope was not inferred from prompt prose.",
        ]
      : []),
  ];
  const withoutIdentity: Omit<MissionContract, "id" | "digest"> = {
    schemaVersion: 1,
    objective: { text: objective, source: "USER_REQUEST" },
    scope: {
      status: paths.length > 0 || exclusions.length > 0 ? "EXPLICIT" : "UNSPECIFIED",
      repositoryPath: request.repositoryPath,
      revision: request.revision,
      paths,
      exclusions,
    },
    constraints: {
      status: constraints.length > 0 ? "EXPLICIT" : "UNSPECIFIED",
      items: constraints,
    },
    acceptanceCriteria: { status: criteriaStatus, items: acceptanceCriteria },
    authority: {
      source: "MAF_POLICY",
      requested: requestedAuthority,
      granted: effectiveGranted,
      denied,
    },
    riskInputs: {
      complexity: "UNKNOWN",
      coupling: "UNKNOWN",
      source: "UNASSESSED_AT_COMPILATION",
    },
    budget: request.budget
      ? { status: "CONFIGURED", ...request.budget }
      : { status: "UNSPECIFIED" },
    executionPolicy: {
      requestedMode: request.requestedMode ?? null,
      selectionAuthority: "MAF_POLICY",
      requiredAssuranceReducibleByBudgetOrModel: false,
    },
    verificationRequirements: {
      deterministicVerification: "REQUIRED",
      specificationStatus:
        request.verification.command || request.verification.expectedFile
          ? "EXPLICIT"
          : "UNSPECIFIED",
      specification: structuredClone(request.verification),
      expectedEvidence,
    },
    contextPolicy: {
      authority: "CONTEXT_OS",
      expansion: "BOUNDED_PAGE_REQUESTS",
      requestedBudget: request.contextBudget ? structuredClone(request.contextBudget) : null,
    },
    preferences: {
      quality: request.qualityPreference ?? "BALANCED",
      model: request.modelPreference?.trim() || null,
      skills,
      authority: "USER_PREFERENCE_ONLY",
    },
    ambiguities,
  };
  const digest = deterministicDigest(withoutIdentity);
  return { ...withoutIdentity, id: `mission-${digest}`, digest };
};

export const effectiveSkillAuthority = (
  mission: MissionContract,
  allowedByBinding: AuthorityCapability[],
): AuthorityCapability[] =>
  allowedByBinding.filter((capability) => mission.authority.granted.includes(capability));
