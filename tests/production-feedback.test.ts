import { describe, expect, it } from "vitest";
import {
  assertProductionFeedback,
  deriveProductionImpact,
  type ProductionFeedback,
} from "../src/domain/production-feedback";

const feedback = (overrides: Partial<ProductionFeedback> = {}): ProductionFeedback => ({
  schemaVersion: 1,
  id: "feedback-1",
  projectId: "project-1",
  runId: "run-1",
  candidateId: "candidate-1",
  candidateDigest: "a".repeat(64),
  releaseRevision: "b".repeat(40),
  strategy: {
    adapter: "agent",
    model: "model",
    provider: "provider",
    executionMode: "GUIDED",
    qualityPreference: "HIGH",
    verificationProfile: "COMMAND",
    reviewPolicy: "NONE",
    baseline: "CHALLENGER",
  },
  scope: {
    projectId: "project-1",
    taskClass: "docs",
    riskProfile: "LOW",
    qualityRequirement: "HIGH",
  },
  type: "INCIDENT",
  severity: "HIGH",
  observedAt: "2026-08-21T00:00:00.000Z",
  source: {
    kind: "VERIFIED_OBSERVABILITY_ADAPTER",
    provider: "sentry",
    externalEventId: "event-1",
  },
  evidenceRef: "sentry:event-1",
  ...overrides,
});

describe("M14 production feedback", () => {
  it("keeps absence UNKNOWN rather than healthy", () => {
    expect(deriveProductionImpact([])).toEqual({
      state: "UNKNOWN",
      strategyDemotionRequired: false,
      maintenanceRecommended: false,
      reasons: ["no trusted production feedback has been observed"],
    });
  });

  it("uses incident and rollback evidence for future demotion and maintenance", () => {
    expect(deriveProductionImpact([feedback()])).toMatchObject({
      state: "DEGRADING",
      strategyDemotionRequired: true,
      maintenanceRecommended: true,
    });
    expect(deriveProductionImpact([feedback({ type: "ROLLBACK", severity: "MEDIUM" })]).state).toBe(
      "DEGRADING",
    );
  });

  it("rejects untrusted or malformed provenance", () => {
    expect(() =>
      assertProductionFeedback({
        ...feedback(),
        source: { kind: "MODEL_CLAIM", provider: "model", externalEventId: "claim" },
      }),
    ).toThrow(/Malformed/u);
    expect(() =>
      assertProductionFeedback({ ...feedback(), releaseRevision: "not-a-revision" }),
    ).toThrow(/Malformed/u);
  });

  it("treats every trusted regression as degrading without over-demoting low severity", () => {
    expect(
      deriveProductionImpact([feedback({ type: "ERROR_RATE_REGRESSION", severity: "MEDIUM" })]),
    ).toMatchObject({
      state: "DEGRADING",
      strategyDemotionRequired: false,
      maintenanceRecommended: true,
    });
  });

  it("refuses to aggregate production impact across projects", () => {
    expect(() =>
      deriveProductionImpact([
        feedback(),
        feedback({
          id: "feedback-2",
          projectId: "project-2",
          scope: { ...feedback().scope, projectId: "project-2" },
        }),
      ]),
    ).toThrow(/cannot mix projects/u);
  });
});
