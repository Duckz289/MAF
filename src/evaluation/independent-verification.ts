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
 * What a `regression` evidence outcome actually establishes. Audit #3 found that a smoke check --
 * "every shipped module loads, every public entrypoint runs to a clean exit" -- reported PASS/FAIL
 * indistinguishably from a full behavioral regression suite would, and that this was easy to
 * misread as comprehensive: a candidate that correctly fixes the graded behavior while silently
 * breaking an unrelated, unexercised exported function still reaches regression=PASS. protocol.json
 * disclosed the limitation in prose; this type makes it impossible for a report or a downstream
 * reader to receive `regression: "PASS"` without also receiving what kind of PASS it is.
 *
 * scope       "SMOKE" is the only value a verifier that only loads modules and runs entrypoints may
 *             report. A future verifier that actually asserts behavior would report "BEHAVIORAL" and
 *             carry a different coverage value -- this type does not need to change to allow that.
 * method      How the scope was established, so a reader does not have to trust the label alone.
 * coverage    "PARTIAL" states plainly that only entrypoint-reachable, throw-detecting behavior was
 *             exercised -- never "FULL" for a check that cannot assert output correctness.
 */
export interface RegressionEvidenceScope {
  scope: "SMOKE";
  method: "MODULE_LOAD_AND_ENTRYPOINT";
  coverage: "PARTIAL";
  /** One-line, human-readable restatement of exactly what this evidence establishes. */
  establishes: string;
  /** One-line, human-readable statement of what it explicitly does NOT establish. */
  doesNotEstablish: string;
}

/** The regression scope every `CuratorIndependentVerifier` check currently reports. Exported so
 *  reports and docs can reference the same literal rather than restating it. */
export const SMOKE_REGRESSION_EVIDENCE: RegressionEvidenceScope = {
  scope: "SMOKE",
  method: "MODULE_LOAD_AND_ENTRYPOINT",
  coverage: "PARTIAL",
  establishes:
    "every module the candidate ships imports without throwing, and every public entrypoint the fixture ships runs to a clean exit",
  doesNotEstablish:
    "the correctness of any exported behavior outside the hidden grader's specific assertions and outside whatever the entrypoint's own call graph happens to exercise",
};

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
  /**
   * What kind of check `regression` reports, so PASS/FAIL is never read as more than it is. Present
   * whenever a verifier actually attempted a regression check (regressionStatus !== "NOT_RUN"), so it
   * describes the check that ran, not a static property of the port itself. Absent when nothing ran
   * (regression stays NOT_CHECKED / regressionStatus stays "NOT_RUN") -- there is no scope to report
   * for a check that never happened, and that absence must not be read as "full coverage" either.
   */
  regressionEvidence?: RegressionEvidenceScope;
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
