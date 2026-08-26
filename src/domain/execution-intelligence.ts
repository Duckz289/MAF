import { deterministicDigest } from "./deterministic-identity";
import type { AuthorityCapability } from "./mission";
import type { ModelCandidate, ModelIdentity, MonetaryCost } from "./model-intelligence";
import type {
  ExecutionMode,
  ModelHealth,
  RuntimeSignalProvenance,
  RuntimeSignalReliability,
} from "./types";

export type DecisionSignalValue = string | number | boolean | null;

export interface ExecutionDecisionSignal {
  name: string;
  value: DecisionSignalValue;
  provenance: RuntimeSignalProvenance;
  reliability: RuntimeSignalReliability;
  evidenceIds: string[];
}

export type ExecutionIntervention = "NONE" | "MAF_GUIDED_SINGLE";

export type ExecutionTopology =
  | { kind: "SINGLE_NATIVE" }
  | {
      kind: "ADVISOR_WORKER_OPTION";
      advisorResponsibility: "ARCHITECTURE_OR_HIGH_AMBIGUITY_JUDGMENT";
      workerAuthority: "BOUNDED_IMPLEMENTATION_ONLY";
      maximumWorkers: number;
      integrationOwner: "CENTRAL";
      default: false;
    };

export interface ExecutionIntelligenceInput {
  taskClass: ExecutionDecisionSignal;
  risk: ExecutionDecisionSignal & { value: "LOW" | "MEDIUM" | "HIGH" };
  coupling: ExecutionDecisionSignal & { value: "LOW" | "MEDIUM" | "HIGH" };
  breadth: ExecutionDecisionSignal & { value: "NARROW" | "BROAD" | null };
  parallelizability: ExecutionDecisionSignal & { value: "LOW" | "HIGH" | null };
  uncertainty: ExecutionDecisionSignal & { value: "LOW" | "MEDIUM" | "HIGH" | null };
  architectureSensitivity: ExecutionDecisionSignal & {
    value: "LOW" | "MEDIUM" | "HIGH";
  };
  contextRequirement: ExecutionDecisionSignal & { value: "MINIMAL" | "BOUNDED" | "EXPANSIVE" };
  budgetStatus: ExecutionDecisionSignal & { value: "AVAILABLE" | "EXHAUSTED" | "UNKNOWN" };
  providerHealth: ExecutionDecisionSignal & { value: ModelHealth };
  requiredAssurance: string[];
  modelCandidates: ModelCandidate[];
}

export interface ExecutionIntelligenceDecision {
  id: string;
  status: "SELECTED" | "BLOCKED_BUDGET" | "BLOCKED_PROVIDER";
  intervention: ExecutionIntervention;
  executionMode: ExecutionMode;
  topology: ExecutionTopology;
  selectedModel: ModelIdentity | null;
  expectedMonetaryCost: MonetaryCost | null;
  requiredAssurance: string[];
  contextPolicy: "MINIMUM_EFFECTIVE_CONTEXT_VIA_CONTEXT_OS";
  inputs: ExecutionDecisionSignal[];
  reasons: string[];
}

const riskOrder: Record<"LOW" | "MEDIUM" | "HIGH", number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const safeForRisk = (candidate: ModelCandidate, risk: "LOW" | "MEDIUM" | "HIGH"): boolean =>
  riskOrder[candidate.maximumRisk] >= riskOrder[risk];

const selectModel = (
  candidates: ModelCandidate[],
  risk: "LOW" | "MEDIUM" | "HIGH",
): ModelCandidate | null => {
  const eligible = candidates.filter(
    (candidate) => candidate.health !== "BROKEN" && safeForRisk(candidate, risk),
  );
  return (
    eligible.toSorted((left, right) => {
      if (left.operatorPinned !== right.operatorPinned) return left.operatorPinned ? -1 : 1;
      if (left.native !== right.native) return left.native ? -1 : 1;
      if (left.qualityTier !== right.qualityTier) return right.qualityTier - left.qualityTier;
      const leftCost = left.monetaryCost.amountUsd;
      const rightCost = right.monetaryCost.amountUsd;
      if (leftCost === null && rightCost !== null) return 1;
      if (leftCost !== null && rightCost === null) return -1;
      return (leftCost ?? 0) - (rightCost ?? 0);
    })[0] ?? null
  );
};

/**
 * Deterministic, advisory selection foundation. It does not mutate RunService routing and cannot
 * alter assurance: budget/model availability changes execution choice, never the trust bar.
 */
export const decideExecutionIntelligence = (
  input: ExecutionIntelligenceInput,
): ExecutionIntelligenceDecision => {
  const inputs = [
    input.taskClass,
    input.risk,
    input.coupling,
    input.breadth,
    input.parallelizability,
    input.uncertainty,
    input.architectureSensitivity,
    input.contextRequirement,
    input.budgetStatus,
    input.providerHealth,
  ];
  const simpleLocal =
    input.risk.value === "LOW" &&
    input.coupling.value === "LOW" &&
    input.architectureSensitivity.value === "LOW" &&
    input.breadth.value === "NARROW" &&
    input.uncertainty.value === "LOW";
  const intervention: ExecutionIntervention = simpleLocal ? "NONE" : "MAF_GUIDED_SINGLE";
  const executionMode: ExecutionMode = simpleLocal
    ? "SOLO_NATIVE"
    : input.coupling.value === "HIGH" || input.uncertainty.value === "HIGH"
      ? "SOLO_NATIVE"
      : input.contextRequirement.value === "MINIMAL"
        ? "STRICT"
        : "GUIDED";
  const topology: ExecutionTopology =
    input.breadth.value === "BROAD" && input.parallelizability.value === "HIGH"
      ? {
          kind: "ADVISOR_WORKER_OPTION",
          advisorResponsibility: "ARCHITECTURE_OR_HIGH_AMBIGUITY_JUDGMENT",
          workerAuthority: "BOUNDED_IMPLEMENTATION_ONLY",
          maximumWorkers: 4,
          integrationOwner: "CENTRAL",
          default: false,
        }
      : { kind: "SINGLE_NATIVE" };
  const selected = selectModel(input.modelCandidates, input.risk.value);
  const reasons = [
    simpleLocal
      ? "Structured low-risk, low-coupling, narrow, low-uncertainty inputs require no MAF orchestration intervention."
      : "Structured risk/coupling/context inputs justify a guided single-agent intervention.",
    topology.kind === "ADVISOR_WORKER_OPTION"
      ? "Breadth and parallelizability make advisor/worker decomposition representable, but it remains non-default."
      : "No structured input justifies advisor/worker orchestration.",
  ];
  const status: ExecutionIntelligenceDecision["status"] =
    input.budgetStatus.value === "EXHAUSTED"
      ? "BLOCKED_BUDGET"
      : input.providerHealth.value === "BROKEN" && selected === null
        ? "BLOCKED_PROVIDER"
        : selected === null
          ? "BLOCKED_PROVIDER"
          : "SELECTED";
  if (status === "BLOCKED_BUDGET") {
    reasons.push("Execution is blocked by budget; required assurance is preserved unchanged.");
  } else if (status === "BLOCKED_PROVIDER") {
    reasons.push(
      "No healthy model candidate is eligible for the mission risk; no trusted fallback was fabricated.",
    );
  } else if (selected) {
    reasons.push(
      `Selected ${selected.identity.provider}/${selected.identity.model} from eligible healthy candidates; cost was only a tie-break after risk suitability, native baseline, and quality tier.`,
    );
  }
  const identity = {
    status,
    intervention,
    executionMode,
    topology,
    selectedModel: selected?.identity ?? null,
    inputs,
    requiredAssurance: input.requiredAssurance,
  };
  return {
    id: `execution-decision-${deterministicDigest(identity)}`,
    status,
    intervention,
    executionMode,
    topology,
    selectedModel: selected?.identity ?? null,
    expectedMonetaryCost: selected?.monetaryCost ?? null,
    requiredAssurance: [...input.requiredAssurance],
    contextPolicy: "MINIMUM_EFFECTIVE_CONTEXT_VIA_CONTEXT_OS",
    inputs: structuredClone(inputs),
    reasons,
  };
};

export interface StructuredAgentHandoff {
  schemaVersion: 1;
  objective: string;
  constraints: string[];
  candidate: { id: string; digest: string } | null;
  sourceRevision: string;
  modifiedInterfaces: string[];
  findings: string[];
  evidenceRefs: string[];
  unresolvedQuestions: string[];
  authority: "CONTEXT_ONLY";
  allowedActions: AuthorityCapability[];
}
