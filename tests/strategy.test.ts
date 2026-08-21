import { describe, expect, it } from "vitest";
import {
  assessStrategy,
  selectStrategy,
  type StrategyIdentity,
  type StrategyObservation,
  type StrategyScope,
} from "../src/domain/strategy";

const projectA = `project-${"a".repeat(64)}`;
const scope: StrategyScope = {
  projectId: projectA,
  taskClass: "cross-module-feature",
  riskProfile: "coupling-medium",
  qualityRequirement: "HIGH",
};
const challenger: StrategyIdentity = {
  adapter: "native-cli",
  model: "challenger",
  provider: "provider-a",
  executionMode: "GUIDED",
  qualityPreference: "HIGH",
  verificationProfile: "command+quality",
  reviewPolicy: "NONE",
  baseline: "CHALLENGER",
};
const frontier: StrategyIdentity = {
  ...challenger,
  model: "frontier",
  executionMode: "NATIVE",
  baseline: "NATIVE_FRONTIER",
};
const observation = (
  index: number,
  overrides: Partial<StrategyObservation> = {},
): StrategyObservation => ({
  id: `observation-${index}`,
  timestamp: new Date(Date.UTC(2026, 7, 21, 0, index)).toISOString(),
  scope,
  strategy: challenger,
  runId: `run-${index}`,
  candidateId: `candidate-${index}`,
  candidateDigest: index.toString(16).padStart(64, "0"),
  verifiedSuccess: true,
  trustState: "DURABLE_VERIFIED",
  costUsd: 0.25,
  latencyMs: 1000,
  retries: 0,
  qualityOutcome: "PASS",
  security: "NOT_REQUIRED",
  performance: "PASS",
  resilience: "PASS",
  healthEffect: "STABLE",
  source: "RUN",
  evidenceBasis: "RUN_STORE_VERIFIED",
  ...overrides,
});

describe("M12 scoped strategy learning", () => {
  it("keeps no and tiny evidence out of promotion", () => {
    expect(assessStrategy(scope, challenger, []).lifecycle).toBe("SHADOW");
    const tiny = [observation(1), observation(2)];
    expect(assessStrategy(scope, challenger, tiny)).toMatchObject({
      lifecycle: "SHADOW",
      eligibleAsDefault: false,
    });
  });

  it("moves sufficient candidate-bound durable evidence through canary to promotion", () => {
    expect(
      assessStrategy(
        scope,
        challenger,
        Array.from({ length: 5 }, (_, i) => observation(i)),
      ),
    ).toMatchObject({ lifecycle: "CANARY", eligibleAsDefault: false });
    expect(
      assessStrategy(
        scope,
        challenger,
        Array.from({ length: 10 }, (_, i) => observation(i)),
      ),
    ).toMatchObject({
      lifecycle: "PROMOTED",
      eligibleAsDefault: true,
      durableSuccesses: 10,
    });
  });

  it("does not treat unknown cost as free promotion evidence", () => {
    const unknownCost = Array.from({ length: 12 }, (_, i) => observation(i, { costUsd: null }));
    const assessment = assessStrategy(scope, challenger, unknownCost);
    expect(assessment.lifecycle).toBe("CANARY");
    expect(assessment.averageKnownCostUsd).toBeNull();
    expect(assessment.reasons.join(" ")).toContain("unknown cost is not free");
  });

  it("does not multiply one candidate or benchmark claims into durable evidence", () => {
    const repeated = Array.from({ length: 12 }, (_, index) => ({
      ...observation(index),
      runId: "same-run",
      candidateId: "same-candidate",
    }));
    expect(assessStrategy(scope, challenger, repeated)).toMatchObject({
      lifecycle: "SHADOW",
      observationCount: 1,
      durableSuccesses: 1,
    });
    const benchmarkClaims = Array.from({ length: 12 }, (_, index) =>
      observation(index, {
        evidenceBasis: "BENCHMARK_OBSERVED",
        source: "BENCHMARK_SHADOW",
      }),
    );
    expect(assessStrategy(scope, challenger, benchmarkClaims)).toMatchObject({
      lifecycle: "CANARY",
      durableSuccesses: 0,
      eligibleAsDefault: false,
    });
  });

  it("demotes material quality/security/reliability degradation", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => observation(i));
    evidence[9] = observation(9, { security: "FAIL" });
    expect(assessStrategy(scope, challenger, evidence).lifecycle).toBe("DEMOTED");
  });

  it("includes store-bound terminal failures instead of learning from survivors only", () => {
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      index < 7
        ? observation(index)
        : observation(index, {
            verifiedSuccess: false,
            trustState: "PROPOSED",
            qualityOutcome: "FAIL",
            security: "NOT_CHECKED",
            performance: "NOT_CHECKED",
            resilience: "NOT_CHECKED",
            healthEffect: "UNKNOWN",
            evidenceBasis: "RUN_STORE_TERMINAL",
          }),
    );
    expect(assessStrategy(scope, challenger, outcomes)).toMatchObject({
      lifecycle: "DEMOTED",
      observationCount: 10,
      verifiedSuccesses: 7,
      verifiedSuccessRate: 0.7,
    });
  });

  it("never lets Project A authorize Project B", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => observation(i));
    const projectB = { ...scope, projectId: `project-${"b".repeat(64)}` };
    expect(assessStrategy(projectB, challenger, evidence).lifecycle).toBe("SHADOW");
  });

  it("keeps native frontier available for critical work with an unapproved challenger", () => {
    const critical = { ...scope, qualityRequirement: "CRITICAL" as const };
    const criticalChallenger = { ...challenger, qualityPreference: "CRITICAL" as const };
    const criticalFrontier = { ...frontier, qualityPreference: "CRITICAL" as const };
    const selection = selectStrategy(critical, criticalFrontier, criticalChallenger, [], 1);
    expect(selection.selected.baseline).toBe("NATIVE_FRONTIER");
    expect(selection.reason).toContain("critical");
  });

  it("rejects contradictory durable claims and failed critical assurance", () => {
    expect(() =>
      assessStrategy(scope, challenger, [
        observation(1, {
          source: "BENCHMARK_SHADOW",
          evidenceBasis: "RUN_STORE_VERIFIED",
        }),
      ]),
    ).toThrow(/contradicts/u);
    const critical = { ...scope, qualityRequirement: "CRITICAL" as const };
    const criticalChallenger = { ...challenger, qualityPreference: "CRITICAL" as const };
    const failed = Array.from({ length: 10 }, (_, index) =>
      observation(index, {
        scope: critical,
        strategy: criticalChallenger,
        performance: "FAIL",
        resilience: "FAIL",
      }),
    );
    expect(assessStrategy(critical, criticalChallenger, failed).lifecycle).toBe("DEMOTED");
  });

  it("requires an explicit valid canary ordinal", () => {
    expect(() => selectStrategy(scope, frontier, challenger, [], -1)).toThrow(/ordinal/u);
  });
});
