import { deterministicDigest } from "./deterministic-identity";
import type { Verification, VerificationEnvironmentBinding, VerificationSpec } from "./types";
import { normalizeVerificationSpecification } from "./verification-spec";

export interface VerificationAuthorityAssessment {
  authorized: boolean;
  reasons: string[];
}

export const verificationEnvironmentIdentity = (
  environment: Omit<VerificationEnvironmentBinding, "identity">,
): string => `verification-environment-${deterministicDigest(environment)}`;

/** Promotion authority requires one evidence record to bind candidate + spec + environment. */
export const assessVerificationAuthority = (input: {
  verification: Verification;
  specification: VerificationSpec;
  candidateDigest: string;
}): VerificationAuthorityAssessment => {
  const reasons: string[] = [];
  const specification = normalizeVerificationSpecification(input.specification);
  if (specification.status !== "CONFIGURED") {
    reasons.push(`verification specification is ${specification.status}`);
  }
  if (input.verification.verificationSpecIdentity !== specification.identity) {
    reasons.push("verification evidence is not bound to the normalized specification identity");
  }
  if (input.verification.candidateDigest !== input.candidateDigest) {
    reasons.push("verification evidence is not bound to the captured candidate identity");
  }

  const environment = input.verification.environment;
  if (!environment) {
    reasons.push("verification evidence has no environment identity");
  } else {
    const { identity, ...withoutIdentity } = environment;
    if (identity !== verificationEnvironmentIdentity(withoutIdentity)) {
      reasons.push("verification environment identity does not match its recorded binding");
    }
    if (
      environment.identityQuality !== "BOUNDED" ||
      environment.promotionAuthority !== "BOUNDED_LOCAL" ||
      environment.materialization !== "FRESH_CANDIDATE_MATERIALIZATION" ||
      environment.candidateContainment !== "WORKSPACE_CONTAINED" ||
      environment.gitMetadata !== "EXCLUDED" ||
      environment.filesystemIsolation !== "FRESH_ROOT_WITH_STATIC_ESCAPE_GUARD"
    ) {
      reasons.push("verification environment containment is insufficient for promotion");
    }
  }
  return { authorized: reasons.length === 0, reasons };
};
