import type { CandidateIntegrity, EvidenceOutcome } from "./types";

// Independent, controller-side verification.
//
// The second independent audit found that the production DVS path derived its three trusted fields
// -- hiddenGrader, regression and candidateIntegrity -- from the participant's own execution report.
// A participant that returned `verificationResult: "VERIFIED"` alongside a fabricated `filesChanged`
// array minted a Durable Verified Success without any independent evidence existing at all.
//
// This module defines the boundary that fixes it. Everything a participant reports is self-reported
// evidence and is recorded diagnostically. The three trusted fields may only come from an
// IndependentVerifier, which the controller owns and the participant can neither run nor observe.
//
// The default is NOT_CHECKED, never PASS. Absence of verification is absence of evidence.

/** Where a run's correctness evidence came from. Only INDEPENDENT evidence can support a DVS. */
export type EvidenceSource = "INDEPENDENT" | "NOT_CHECKED";

/** Outcome of a controller-side check that actually ran, or the reason it did not. */
export type VerificationStatus = "PASS" | "FAIL" | "INVALID" | "NOT_RUN";

/**
 * What the controller itself observed about the candidate artifact. Every field here is measured by
 * the controller against a workspace it owns; none of it is taken from the participant.
 */
export interface CandidateArtifactEvidence {
  /** The controller-owned workspace the participant was given still exists. */
  workspaceExists: boolean;
  /** Every observed change resolved inside that workspace. */
  containedInWorkspace: boolean;
  /** Files the controller observed as changed, by comparing against the baseline it materialized. */
  observedChangedFiles: string[];
  /** The candidate parses / loads as the task expects. */
  structurallyValid: boolean;
  /** The controller quarantined the candidate (corruption, policy violation, unreadable). */
  quarantined: boolean;
}

export interface IndependentVerificationResult {
  source: EvidenceSource;
  candidateIntegrity: CandidateIntegrity;
  /** True only when the controller observed a real candidate artifact. */
  candidateExists: boolean;
  hiddenGrader: EvidenceOutcome;
  regression: EvidenceOutcome;
  graderStatus: VerificationStatus;
  regressionStatus: VerificationStatus;
  artifact?: CandidateArtifactEvidence;
  notes: string[];
}

export interface IndependentVerificationInput {
  taskId: string;
  /** Verification command the task declares, if the controller can run one. */
  expectedVerification?: string;
  /** Controller-owned workspace path, when the controller materialized one. */
  workspacePath?: string;
}

/**
 * The controller-side verifier port. An implementation runs the task's hidden grader and a
 * deterministic regression check against a workspace the controller owns, after the participant has
 * finished. Participants never receive this object and never see the grader.
 */
export interface IndependentVerifier {
  verify(input: IndependentVerificationInput): Promise<IndependentVerificationResult>;
}

/**
 * The result used when no independent verification ran. Everything is NOT_CHECKED and integrity is
 * UNKNOWN, so a run built from it can never be a DVS. This is the default, deliberately: a missing
 * verifier must fail closed rather than inherit a participant's optimism.
 */
export const notVerified = (
  note = "no independent verifier was configured",
): IndependentVerificationResult => ({
  source: "NOT_CHECKED",
  candidateIntegrity: "UNKNOWN",
  candidateExists: false,
  hiddenGrader: "NOT_CHECKED",
  regression: "NOT_CHECKED",
  graderStatus: "NOT_RUN",
  regressionStatus: "NOT_RUN",
  notes: [note],
});

/**
 * A verifier that always declines. Used as the runner's default so that wiring a benchmark without a
 * verifier produces no successes rather than unverified ones.
 */
export const nullIndependentVerifier: IndependentVerifier = {
  async verify() {
    return notVerified();
  },
};

/**
 * Derives candidate integrity from what the controller observed, never from a participant's claim.
 *
 * A fabricated file list cannot reach this function: `observedChangedFiles` is the controller's own
 * diff of the workspace it materialized.
 */
export const candidateIntegrityFromArtifact = (
  artifact: CandidateArtifactEvidence,
): { candidateIntegrity: CandidateIntegrity; candidateExists: boolean; notes: string[] } => {
  const notes: string[] = [];
  if (!artifact.workspaceExists) {
    return {
      candidateIntegrity: "MISSING",
      candidateExists: false,
      notes: ["the controller-owned candidate workspace does not exist"],
    };
  }
  if (artifact.observedChangedFiles.length === 0) {
    return {
      candidateIntegrity: "MISSING",
      candidateExists: false,
      notes: ["the controller observed no change to the candidate workspace"],
    };
  }
  if (artifact.quarantined) notes.push("the candidate was quarantined by the controller");
  if (!artifact.containedInWorkspace)
    notes.push("a candidate change resolved outside the workspace");
  if (!artifact.structurallyValid) notes.push("the candidate is not structurally valid");
  const invalid =
    artifact.quarantined || !artifact.containedInWorkspace || !artifact.structurallyValid;
  return {
    candidateIntegrity: invalid ? "INVALID" : "VALID",
    candidateExists: true,
    notes,
  };
};

/** Maps a controller-side check outcome onto the protocol's evidence vocabulary. */
export const evidenceForStatus = (status: VerificationStatus): EvidenceOutcome => {
  switch (status) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return "FAIL";
    case "INVALID":
      // The check ran but could not reach a verdict. That is not a pass and not a clean failure.
      return "UNKNOWN";
    default:
      return "NOT_CHECKED";
  }
};
