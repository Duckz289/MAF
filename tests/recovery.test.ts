import { describe, expect, it } from "vitest";
import {
  AgentReportedFailure,
  buildRecoveryCapsule,
  candidateLineage,
  classifyFailure,
  isAutoRetryable,
  strongestCandidate,
  verificationSeverity,
} from "../src/domain/recovery";
import type { Artifact, Task, Verification } from "../src/domain/types";

describe("classifyFailure", () => {
  it("classifies known error signatures deterministically", () => {
    expect(classifyFailure(new Error("Too many requests, HTTP 429"))).toBe("RATE_LIMIT");
    expect(classifyFailure(new Error("Invalid API key: authentication failed"))).toBe(
      "CREDENTIAL_FAILURE",
    );
    expect(classifyFailure(new Error("Bad Gateway (502)"))).toBe("PROVIDER_DEGRADED");
    expect(classifyFailure(new Error("connect ECONNRESET"))).toBe("NETWORK_FAILURE");
    expect(classifyFailure(new Error("EACCES: permission denied opening worktree"))).toBe(
      "ENVIRONMENT_FAILURE",
    );
    expect(classifyFailure(new Error("Run cancelled"))).toBe("USER_INTERRUPT");
    expect(classifyFailure(new Error("Agent failed"))).toBe("AGENT_FAILURE");
    expect(classifyFailure(new Error("request timed out after 30s"))).toBe("PROVIDER_TRANSIENT");
  });

  it("defaults honestly to UNKNOWN_FAILURE rather than guessing", () => {
    expect(classifyFailure(new Error("something bizarre and unrecognized happened"))).toBe(
      "UNKNOWN_FAILURE",
    );
    expect(classifyFailure("a plain string, not even an Error")).toBe("UNKNOWN_FAILURE");
  });

  it("trusts an explicit cancellation hint over any message pattern-match", () => {
    expect(classifyFailure(new Error("ECONNRESET"), { cancelled: true })).toBe("USER_INTERRUPT");
  });

  it("never pattern-matches agent-reported text into a more specific category", () => {
    // Agent output is a proposal, never silently trusted: an agent could put ANY text into its
    // own error message. Without the agentReported flag, each of these would be misclassified
    // into a category the harness never actually verified — including the harness's own
    // cancellation sentinel, letting an agent dodge capsule capture by claiming USER_INTERRUPT.
    expect(classifyFailure(new Error("Too many requests, HTTP 429"), { agentReported: true })).toBe(
      "AGENT_FAILURE",
    );
    expect(
      classifyFailure(new Error("Invalid API key: authentication failed"), {
        agentReported: true,
      }),
    ).toBe("AGENT_FAILURE");
    expect(classifyFailure(new Error("Run cancelled"), { agentReported: true })).toBe(
      "AGENT_FAILURE",
    );
    expect(
      classifyFailure(new AgentReportedFailure("connect ECONNRESET"), { agentReported: true }),
    ).toBe("AGENT_FAILURE");
  });

  it("still classifies a genuine cancellation as USER_INTERRUPT even if agentReported is also set", () => {
    // A definite harness-known fact (cancelled) must win over an uncertain one (agentReported).
    expect(classifyFailure(new Error("anything"), { cancelled: true, agentReported: true })).toBe(
      "USER_INTERRUPT",
    );
  });
});

describe("isAutoRetryable", () => {
  it("only marks failure classes with a real chance of succeeding on retry", () => {
    expect(isAutoRetryable("PROVIDER_TRANSIENT")).toBe(true);
    expect(isAutoRetryable("PROVIDER_DEGRADED")).toBe(true);
    expect(isAutoRetryable("RATE_LIMIT")).toBe(true);
    expect(isAutoRetryable("NETWORK_FAILURE")).toBe(true);
    expect(isAutoRetryable("AGENT_FAILURE")).toBe(true);
  });

  it("requires explicit resume/escalation for everything else", () => {
    expect(isAutoRetryable("CREDENTIAL_FAILURE")).toBe(false);
    expect(isAutoRetryable("ENVIRONMENT_FAILURE")).toBe(false);
    expect(isAutoRetryable("BUDGET_EXHAUSTED")).toBe(false);
    expect(isAutoRetryable("USER_INTERRUPT")).toBe(false);
    expect(isAutoRetryable("REVISION_CONFLICT")).toBe(false);
    expect(isAutoRetryable("VERIFICATION_FAILURE")).toBe(false);
    expect(isAutoRetryable("UNKNOWN_FAILURE")).toBe(false);
  });
});

describe("verificationSeverity", () => {
  it("orders states from least to most severe", () => {
    expect(verificationSeverity({ state: "VERIFIED" })).toBeLessThan(
      verificationSeverity({ state: "QUARANTINED" }),
    );
    expect(verificationSeverity({ state: "QUARANTINED" })).toBeLessThan(
      verificationSeverity({ state: "FAILED" }),
    );
  });
});

const artifact = (
  candidateId: string,
  attempt: number,
  parentCandidateId: string | null,
): Artifact => ({
  id: `artifact-${candidateId}`,
  runId: "run-1",
  kind: "DIFF",
  uri: `sandbox://run-1/candidate-${attempt}.patch`,
  digest: `digest-${candidateId}`,
  metadata: { candidateId, attempt, parentCandidateId, changedFiles: [] },
  createdAt: "2026-08-19T00:00:00.000Z",
});

const verification = (
  candidateId: string,
  attempt: number,
  state: Verification["state"],
): Verification => ({
  id: `verification-${candidateId}`,
  runId: "run-1",
  type: "command",
  state,
  output: "",
  startedAt: "2026-08-19T00:00:00.000Z",
  completedAt: "2026-08-19T00:00:01.000Z",
  attempt,
  candidateId,
});

describe("candidateLineage and strongestCandidate", () => {
  it("reconstructs lineage from persisted artifacts and verifications", () => {
    const artifacts = [artifact("c1", 1, null), artifact("c2", 2, "c1")];
    const verifications = [verification("c1", 1, "QUARANTINED"), verification("c2", 2, "VERIFIED")];
    const lineage = candidateLineage(artifacts, verifications);
    expect(lineage).toHaveLength(2);
    expect(lineage[0]).toMatchObject({ id: "c1", attempt: 1, parentCandidateId: null });
    expect(lineage[1]).toMatchObject({ id: "c2", attempt: 2, parentCandidateId: "c1" });
  });

  it("never lets a worse later attempt hide a stronger earlier candidate", () => {
    const artifacts = [artifact("c1", 1, null), artifact("c2", 2, "c1"), artifact("c3", 3, "c2")];
    const verifications = [
      verification("c1", 1, "VERIFIED"),
      verification("c2", 2, "QUARANTINED"),
      verification("c3", 3, "FAILED"),
    ];
    const lineage = candidateLineage(artifacts, verifications);
    expect(strongestCandidate(lineage)?.id).toBe("c1");
  });

  it("prefers the later attempt on a severity tie", () => {
    const artifacts = [artifact("c1", 1, null), artifact("c2", 2, "c1")];
    const verifications = [
      verification("c1", 1, "QUARANTINED"),
      verification("c2", 2, "QUARANTINED"),
    ];
    const lineage = candidateLineage(artifacts, verifications);
    expect(strongestCandidate(lineage)?.id).toBe("c2");
  });

  it("returns undefined when nothing has been verified yet", () => {
    expect(strongestCandidate(candidateLineage([artifact("c1", 1, null)], []))).toBeUndefined();
  });
});

describe("buildRecoveryCapsule", () => {
  const task: Task = {
    id: "task-1",
    prompt: "Fix the thing",
    repositoryPath: "/repo",
    revision: "HEAD",
    createdAt: "2026-08-19T00:00:00.000Z",
    verification: {},
  };

  it("never carries hidden chain-of-thought, only already-structured evidence", () => {
    const capsule = buildRecoveryCapsule({
      runId: "run-1",
      task,
      agent: "fixture",
      model: "native",
      provider: "native",
      desiredMode: "GUIDED",
      effectiveMode: "GUIDED",
      costSpent: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
      workspacePath: "/workspace",
      resolvedRevision: "abc123",
      artifacts: [artifact("c1", 1, null)],
      verifications: [verification("c1", 1, "VERIFIED")],
      knowledge: [
        {
          id: "fact-1",
          projectId: "/repo",
          revision: "HEAD",
          kind: "FACT",
          statement: "auth is enforced in the service layer",
          evidenceIds: ["evidence-1"],
          status: "ACTIVE",
          createdAt: "2026-08-19T00:00:00.000Z",
        },
      ],
      recoveryReason: "NETWORK_FAILURE",
      recoveryDetail: "connect ECONNRESET",
      now: "2026-08-19T00:05:00.000Z",
    });
    expect(capsule).toMatchObject({
      runId: "run-1",
      taskId: "task-1",
      goal: "Fix the thing",
      repositoryPath: "/repo",
      requestedRevision: "HEAD",
      resolvedRevision: "abc123",
      remainingBudget: null,
      strongestCandidateId: "c1",
      recoveryReason: "NETWORK_FAILURE",
      recoveryDetail: "connect ECONNRESET",
      verifiedFacts: ["auth is enforced in the service layer"],
      decisions: [],
    });
    // Only known top-level fields exist — nothing resembling a raw reasoning trace was added.
    expect(Object.keys(capsule).sort()).toEqual(
      [
        "agent",
        "candidateLineage",
        "costSpent",
        "createdAt",
        "decisions",
        "desiredMode",
        "effectiveMode",
        "goal",
        "latestSignalSnapshotId",
        "latestVerification",
        "model",
        "provider",
        "recoveryDetail",
        "recoveryReason",
        "remainingBudget",
        "repositoryPath",
        "requestedRevision",
        "resolvedRevision",
        "runId",
        "strongestCandidateId",
        "taskId",
        "verifiedFacts",
        "workspacePath",
      ].sort(),
    );
  });
});
