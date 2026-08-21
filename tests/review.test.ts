import { describe, expect, it } from "vitest";

import { buildAssurancePlan } from "../src/domain/assurance";
import { buildReviewPrompt, parseReviewVerdict } from "../src/domain/review";
import { deriveRiskVector } from "../src/domain/risk";

const riskVector = deriveRiskVector({
  files: ["src/api/auth/session.ts"],
  moduleOwnership: { "src/api/auth/session.ts": "api" },
  packageOwnership: { "src/api/auth/session.ts": "src" },
  crossModuleEdgeCount: 1,
});
const plan = buildAssurancePlan(riskVector, "CRITICAL");

const candidateId = "candidate-42";
const diffDigest = "sha256:abc123";

const verdictJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    candidateId,
    diffDigest,
    approved: true,
    reasons: ["Looks correct."],
    ...overrides,
  });

describe("buildReviewPrompt", () => {
  const prompt = buildReviewPrompt({
    requirements: "Fix the session expiry bug.",
    candidateId,
    diffDigest,
    diffPatch: "--- a/src/api/auth/session.ts\n+++ b/src/api/auth/session.ts\n",
    riskVector,
    assurancePlan: plan,
    verdictFileName: "independent-review-verdict.json",
  });

  it("binds the prompt to the exact candidate under review", () => {
    expect(prompt).toContain(`candidateId: ${candidateId}`);
    expect(prompt).toContain(`diffDigest: ${diffDigest}`);
  });

  it("carries requirements, the diff, and the verdict contract", () => {
    expect(prompt).toContain("Fix the session expiry bug.");
    expect(prompt).toContain("src/api/auth/session.ts");
    expect(prompt).toContain("independent-review-verdict.json");
    expect(prompt).toContain('"approved": boolean');
  });

  it("states the fresh-context contract explicitly", () => {
    expect(prompt).toContain("independent reviewer");
    expect(prompt).toContain("have not seen the");
    // The prompt denies the author's reasoning/confidence rather than quoting it.
    expect(prompt).toContain("confidence");
  });
});

describe("parseReviewVerdict", () => {
  it("approves a well-formed verdict echoing the exact candidate identity", () => {
    const verdict = parseReviewVerdict(verdictJson(), { candidateId, diffDigest });
    expect(verdict.status).toBe("APPROVED");
    expect(verdict.reasons).toEqual(["Looks correct."]);
  });

  it("rejects an explicit disapproval", () => {
    const verdict = parseReviewVerdict(verdictJson({ approved: false }), {
      candidateId,
      diffDigest,
    });
    expect(verdict.status).toBe("REJECTED");
  });

  it("is INVALID when no verdict file was produced", () => {
    const verdict = parseReviewVerdict(undefined, { candidateId, diffDigest });
    expect(verdict.status).toBe("INVALID");
    expect(verdict.reasons[0]).toContain("did not produce a verdict file");
  });

  it("is INVALID for malformed JSON", () => {
    const verdict = parseReviewVerdict("{not json", { candidateId, diffDigest });
    expect(verdict.status).toBe("INVALID");
  });

  it("is INVALID when the shape is wrong (approved not a boolean)", () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({ candidateId, diffDigest, approved: "yes" }),
      { candidateId, diffDigest },
    );
    expect(verdict.status).toBe("INVALID");
  });

  it("is INVALID for a verdict about a different candidate — a review of A can never promote B", () => {
    const verdict = parseReviewVerdict(verdictJson({ candidateId: "someone-else" }), {
      candidateId,
      diffDigest,
    });
    expect(verdict.status).toBe("INVALID");
    expect(verdict.reasons[0]).toContain("someone-else");
  });

  it("is INVALID for a verdict about a different diff", () => {
    const verdict = parseReviewVerdict(verdictJson({ diffDigest: "sha256:other" }), {
      candidateId,
      diffDigest,
    });
    expect(verdict.status).toBe("INVALID");
    expect(verdict.reasons[0]).toContain("sha256:other");
  });

  it("is INVALID when reasons is missing or not a string[] — an unjustified verdict is not valid", () => {
    const missing = parseReviewVerdict(verdictJson({ reasons: undefined }), {
      candidateId,
      diffDigest,
    });
    expect(missing.status).toBe("INVALID");
    expect(missing.reasons[0]).toContain("reasons");
    const nonArray = parseReviewVerdict(verdictJson({ reasons: "because" }), {
      candidateId,
      diffDigest,
    });
    expect(nonArray.status).toBe("INVALID");
    const nonStrings = parseReviewVerdict(verdictJson({ reasons: ["ok", 42] }), {
      candidateId,
      diffDigest,
    });
    expect(nonStrings.status).toBe("INVALID");
    const empty = parseReviewVerdict(verdictJson({ reasons: [] }), {
      candidateId,
      diffDigest,
    });
    expect(empty.status).toBe("INVALID");
  });
});
