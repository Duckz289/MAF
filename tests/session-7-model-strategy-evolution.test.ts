import { describe, expect, it } from "vitest";
import {
  decideExecutionIntelligence,
  type ExecutionDecisionSignal,
  type ExecutionIntelligenceInput,
} from "../src/domain/execution-intelligence";
import {
  createEvaluationRecord,
  createEvolutionCandidate,
  decidePromotion,
  evaluationTrustProjection,
  frozenSuite,
  type EvaluationMetrics,
  type OptimizableArtifactIdentity,
} from "../src/domain/evolution";
import {
  aggregateCostRecords,
  createCostRecord,
  measuredMonetaryCost,
  normalizeModelIdentity,
  subscriptionMonetaryCost,
  unknownMonetaryCost,
} from "../src/domain/model-intelligence";
import { deterministicDigest } from "../src/domain/deterministic-identity";
import { BifrostModelGateway } from "../src/infrastructure/model-gateway";

const model = normalizeModelIdentity({
  provider: "native",
  model: "frontier",
  executionInterface: "NATIVE_CLI",
});

describe("SESSION 7 model and cost intelligence", () => {
  it("keeps UNKNOWN, estimated, exact, and subscription-native cost distinct", async () => {
    const gateway = new BifrostModelGateway(
      { baseUrl: "http://127.0.0.1:1", maxRetries: 0, models: [] },
      { resolve: async () => "never-used" },
    );
    expect(
      await gateway.estimateCost("provider", "model", { input: 1, output: 1, cached: 0 }),
    ).toEqual({
      status: "UNKNOWN",
      amountUsd: null,
      source: "no model pricing catalog is configured",
    });
    expect(measuredMonetaryCost(0, "ESTIMATED", "catalog")).toEqual({
      status: "ESTIMATED",
      amountUsd: 0,
      source: "catalog",
    });
    expect(subscriptionMonetaryCost("native subscription")).toMatchObject({
      status: "SUBSCRIPTION_INCLUDED",
      amountUsd: null,
    });
    expect(unknownMonetaryCost()).toMatchObject({ status: "UNKNOWN", amountUsd: null });
  });

  it("accumulates retry/orchestration usage and preserves unknown components", () => {
    const first = createCostRecord({
      model,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 10,
        quality: "PROVIDER_REPORTED",
      },
      monetary: measuredMonetaryCost(0.4, "ESTIMATED", "catalog"),
      latencyMs: 100,
      retryCount: 0,
      orchestration: { advisorCalls: 1, workerCalls: 1 },
    });
    const retry = createCostRecord({
      model,
      monetary: unknownMonetaryCost("provider omitted retry cost"),
      latencyMs: null,
      retryCount: 1,
      orchestration: { recoveryCalls: 1, verificationCalls: 1 },
    });
    const aggregate = aggregateCostRecords(model, [first, retry]);
    expect(aggregate.monetary.status).toBe("UNKNOWN");
    expect(aggregate.knownSubtotalUsd).toBe(0.4);
    expect(aggregate.unknownComponentCount).toBe(1);
    expect(aggregate.retryCount).toBe(1);
    expect(aggregate.orchestration).toEqual({
      advisorCalls: 1,
      workerCalls: 1,
      verificationCalls: 1,
      recoveryCalls: 1,
    });
  });
});

const signal = <T extends ExecutionDecisionSignal["value"]>(
  name: string,
  value: T,
): ExecutionDecisionSignal & { value: T } => ({
  name,
  value,
  provenance: "DETERMINISTIC",
  reliability: "HIGH",
  evidenceIds: [`evidence-${name}`],
});

const decisionInput = (
  overrides: Partial<ExecutionIntelligenceInput> = {},
): ExecutionIntelligenceInput => ({
  taskClass: signal("taskClass", "LOCAL_CHANGE"),
  risk: signal("risk", "LOW"),
  coupling: signal("coupling", "LOW"),
  breadth: signal("breadth", "NARROW"),
  parallelizability: signal("parallelizability", "LOW"),
  uncertainty: signal("uncertainty", "LOW"),
  architectureSensitivity: signal("architectureSensitivity", "LOW"),
  contextRequirement: signal("contextRequirement", "MINIMAL"),
  budgetStatus: signal("budgetStatus", "AVAILABLE"),
  providerHealth: signal("providerHealth", "HEALTHY"),
  requiredAssurance: ["CORRECTNESS"],
  modelCandidates: [
    {
      identity: model,
      health: "HEALTHY",
      qualityTier: 3,
      maximumRisk: "HIGH",
      monetaryCost: subscriptionMonetaryCost("native subscription"),
      native: true,
      operatorPinned: false,
    },
  ],
  ...overrides,
});

describe("SESSION 7 strategy decision provenance", () => {
  it("represents minimum intervention and stronger coupling without task-name heuristics", () => {
    const simple = decideExecutionIntelligence(decisionInput());
    const coupled = decideExecutionIntelligence(
      decisionInput({
        coupling: signal("coupling", "HIGH"),
        architectureSensitivity: signal("architectureSensitivity", "HIGH"),
      }),
    );
    expect(simple).toMatchObject({
      status: "SELECTED",
      intervention: "NONE",
      topology: { kind: "SINGLE_NATIVE" },
      contextPolicy: "MINIMUM_EFFECTIVE_CONTEXT_VIA_CONTEXT_OS",
    });
    expect(coupled).toMatchObject({
      status: "SELECTED",
      intervention: "MAF_GUIDED_SINGLE",
      executionMode: "SOLO_NATIVE",
    });
    expect(coupled.inputs.find((item) => item.name === "coupling")).toMatchObject({
      value: "HIGH",
      provenance: "DETERMINISTIC",
    });
  });

  it("does not let cheap, unhealthy, or exhausted choices reduce assurance", () => {
    const cheapUnsafe = normalizeModelIdentity({
      provider: "cheap",
      model: "small",
      executionInterface: "API_GATEWAY",
    });
    const highRisk = decideExecutionIntelligence(
      decisionInput({
        risk: signal("risk", "HIGH"),
        requiredAssurance: ["CORRECTNESS", "SECURITY", "INDEPENDENT_REVIEW"],
        modelCandidates: [
          {
            identity: cheapUnsafe,
            health: "HEALTHY",
            qualityTier: 1,
            maximumRisk: "LOW",
            monetaryCost: measuredMonetaryCost(0.01, "ESTIMATED", "catalog"),
            native: false,
            operatorPinned: false,
          },
          ...decisionInput().modelCandidates,
        ],
      }),
    );
    expect(highRisk.selectedModel).toEqual(model);
    expect(highRisk.requiredAssurance).toEqual(["CORRECTNESS", "SECURITY", "INDEPENDENT_REVIEW"]);

    const exhausted = decideExecutionIntelligence(
      decisionInput({ budgetStatus: signal("budgetStatus", "EXHAUSTED") }),
    );
    expect(exhausted.status).toBe("BLOCKED_BUDGET");
    expect(exhausted.requiredAssurance).toEqual(["CORRECTNESS"]);

    const unhealthy = decideExecutionIntelligence(
      decisionInput({
        providerHealth: signal("providerHealth", "BROKEN"),
        modelCandidates: decisionInput().modelCandidates.map((candidate) => ({
          ...candidate,
          health: "BROKEN",
        })),
      }),
    );
    expect(unhealthy.status).toBe("BLOCKED_PROVIDER");
    expect(unhealthy.selectedModel).toBeNull();
  });
});

const metrics: EvaluationMetrics = {
  taskSuccess: true,
  verificationPassed: true,
  durableVerifiedSuccess: null,
  hiddenRegressionPassed: true,
  cost: null,
  contextCharacters: null,
  latencyMs: null,
  retries: null,
  humanInterventionCount: null,
};

const artifact = (
  kind: OptimizableArtifactIdentity["class"],
  id: string,
): OptimizableArtifactIdentity => ({
  class: kind,
  id,
  version: "1",
  digest: deterministicDigest({ kind, id }),
});

describe("SESSION 7 governed evolution", () => {
  it.each([
    "PROMPT",
    "SKILL",
    "CONTEXT_POLICY",
    "MODEL_ROUTING_POLICY",
  ] as const)("%s challengers cannot self-promote or project a trust result", (kind) => {
    const baseline = artifact(kind, "baseline");
    const challenger = createEvolutionCandidate({
      identity: artifact(kind, "challenger"),
      baseline,
      constitutionDigest: deterministicDigest("immutable trust constitution"),
    });
    const suite = frozenSuite({ id: "suite", version: "1", datasetIdentity: ["case-a"] });
    expect(() =>
      decidePromotion({
        candidate: challenger,
        evaluations: [],
        suite,
        authority: "CANDIDATE_REPORT",
        decision: "PROMOTED",
      }),
    ).toThrow(/cannot self-promote/u);
    const record = createEvaluationRecord({
      candidate: challenger.identity,
      baseline,
      suite,
      stage: "OFFLINE_REPLAY",
      result: "PASS",
      metrics,
      evidenceRefs: [],
    });
    expect(evaluationTrustProjection(record)).toBeNull();
    expect(record.trustAuthority).toBe("NONE");
  });

  it("binds frozen evaluation lineage and requires MAF-owned regression/holdout/shadow evidence", () => {
    const baseline = artifact("PROMPT", "baseline");
    const challenger = createEvolutionCandidate({
      identity: artifact("PROMPT", "challenger"),
      baseline,
      constitutionDigest: deterministicDigest("immutable trust constitution"),
    });
    const suiteOne = frozenSuite({ id: "holdout", version: "1", datasetIdentity: ["case-a"] });
    const suiteTwo = frozenSuite({ id: "holdout", version: "2", datasetIdentity: ["case-b"] });
    expect(suiteOne.digest).not.toBe(suiteTwo.digest);
    const records = (["REGRESSION", "FROZEN_HOLDOUT", "SHADOW"] as const).map((stage) =>
      createEvaluationRecord({
        candidate: challenger.identity,
        baseline,
        suite: suiteOne,
        stage,
        result: "PASS",
        metrics,
        evidenceRefs: [`evidence-${stage}`],
      }),
    );
    const mixedSuites = records.map((record, index) =>
      index === 0 ? record : { ...record, suite: suiteTwo },
    );
    expect(() =>
      decidePromotion({
        candidate: challenger,
        evaluations: mixedSuites,
        suite: suiteOne,
        authority: "MAF_POLICY",
        decision: "PROMOTED",
      }),
    ).toThrow(/regression, frozen holdout, and shadow/u);
    const promoted = decidePromotion({
      candidate: challenger,
      evaluations: records,
      suite: suiteOne,
      authority: "MAF_POLICY",
      decision: "PROMOTED",
    });
    expect(promoted.lifecycle).toBe("PROMOTED");
    expect(promoted.promotionDecision?.authority).toBe("MAF_POLICY");
  });
});
