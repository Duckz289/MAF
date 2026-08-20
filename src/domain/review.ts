import type { AssurancePlan } from "./assurance";
import type { RiskVector } from "./risk";

/**
 * M6C independent review: only invoked when the assurance plan requires INDEPENDENT_REVIEW (HIGH
 * SecuritySensitivity and CRITICAL quality preference -- see M5A). The reviewer is a fresh agent
 * session that never sees the implementing agent's own conversation, confidence claims, or
 * conclusion -- only the task's requirements, the candidate's identity, the diff, and
 * already-structured evidence (risk vector, assurance plan reasons). This module builds that
 * prompt and parses the reviewer's response; it never runs a session itself (that is RunService's
 * job, since it owns AgentAdapter).
 */

export type ReviewVerdictStatus = "APPROVED" | "REJECTED" | "INVALID";

export interface ReviewVerdict {
  status: ReviewVerdictStatus;
  reasons: string[];
}

export interface ReviewPromptInput {
  requirements: string;
  candidateId: string;
  diffDigest: string;
  diffPatch: string;
  riskVector: RiskVector;
  assurancePlan: AssurancePlan;
  verdictFileName: string;
}

const summarizeRisk = (riskVector: RiskVector): string =>
  Object.entries(riskVector)
    .map(([dimension, value]) => `- ${dimension}: ${value.level} (${value.provenance})`)
    .join("\n");

const summarizePlan = (plan: AssurancePlan): string =>
  [...plan.required, ...plan.notRequired]
    .sort()
    .map(
      (check) =>
        `- ${check}: ${plan.required.includes(check) ? "REQUIRED" : "not required"} -- ${plan.reasons[check]}`,
    )
    .join("\n");

export const buildReviewPrompt = (input: ReviewPromptInput): string =>
  [
    "You are an independent reviewer. You did not write this change and have not seen the",
    "implementing agent's reasoning, confidence, or conclusions -- do not assume the change is",
    "correct or complete. Evaluate it strictly from the requirements, the diff, and the evidence",
    "below.",
    "",
    "Requirements:",
    input.requirements,
    "",
    "Candidate under review:",
    `- candidateId: ${input.candidateId}`,
    `- diffDigest: ${input.diffDigest}`,
    "",
    "Risk profile (deterministic evidence, not a model judgment):",
    summarizeRisk(input.riskVector),
    "",
    "Assurance plan (what this change is required to satisfy, and why):",
    summarizePlan(input.assurancePlan),
    "",
    "Diff under review:",
    input.diffPatch,
    "",
    `Write your verdict as JSON to a file named "${input.verdictFileName}" in the repository root,`,
    'with exactly this shape: {"candidateId": string, "diffDigest": string, "approved": boolean,',
    '"reasons": string[]}. candidateId and diffDigest MUST be echoed back exactly as given above.',
    '"reasons" must explain your verdict concretely, citing specific lines or files where',
    "relevant. Do not modify any other file.",
  ].join("\n");

/**
 * Never defaults to approved on ambiguity -- a missing, malformed, or type-mismatched verdict, or
 * one that does not echo the exact candidateId and diffDigest it was asked to review, is honestly
 * reported as INVALID, not silently treated as a pass. This is the same "unknown remains unknown"
 * and "agents cannot increase their own authority" discipline used throughout the program: an
 * unparseable or misdirected verdict must not raise trust. A verdict for the WRONG candidate is
 * rejected outright -- a review of Candidate A can never promote Candidate B.
 */
export const parseReviewVerdict = (
  raw: string | undefined,
  expected: { candidateId: string; diffDigest: string },
): ReviewVerdict => {
  if (raw === undefined) {
    return { status: "INVALID", reasons: ["reviewer did not produce a verdict file"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "INVALID", reasons: ["reviewer's verdict file was not valid JSON"] };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { approved?: unknown }).approved !== "boolean"
  ) {
    return {
      status: "INVALID",
      reasons: [
        'reviewer\'s verdict file did not match the required {"candidateId": string, "diffDigest": string, "approved": boolean, ...} shape',
      ],
    };
  }
  const record = parsed as {
    approved: boolean;
    candidateId?: unknown;
    diffDigest?: unknown;
    reasons?: unknown;
  };
  if (record.candidateId !== expected.candidateId) {
    return {
      status: "INVALID",
      reasons: [
        `verdict references candidateId ${JSON.stringify(record.candidateId ?? null)}, not the candidate under review (${expected.candidateId})`,
      ],
    };
  }
  if (record.diffDigest !== expected.diffDigest) {
    return {
      status: "INVALID",
      reasons: [
        `verdict references diffDigest ${JSON.stringify(record.diffDigest ?? null)}, not the diff under review (${expected.diffDigest})`,
      ],
    };
  }
  const reasonsField = record.reasons;
  if (
    !Array.isArray(reasonsField) ||
    reasonsField.length === 0 ||
    !reasonsField.every((reason) => typeof reason === "string")
  ) {
    return {
      status: "INVALID",
      reasons: [
        'reviewer\'s verdict did not include a non-empty "reasons": string[] -- a verdict with no stated justification is not a valid verdict',
      ],
    };
  }
  return { status: record.approved ? "APPROVED" : "REJECTED", reasons: reasonsField };
};
