import crypto from "node:crypto";
import type { StrategyIdentity, StrategyScope } from "./strategy";

export type ProductionFeedbackType =
  | "INCIDENT"
  | "ROLLBACK"
  | "ERROR_RATE_REGRESSION"
  | "LATENCY_REGRESSION"
  | "SECURITY_FINDING";

export interface ProductionFeedback {
  schemaVersion: 1;
  id: string;
  projectId: string;
  runId: string;
  candidateId: string;
  candidateDigest: string;
  releaseRevision: string;
  strategy: StrategyIdentity;
  scope: StrategyScope;
  type: ProductionFeedbackType;
  severity: "LOW" | "MEDIUM" | "HIGH";
  observedAt: string;
  source: {
    kind: "VERIFIED_OBSERVABILITY_ADAPTER" | "SIGNED_WEBHOOK";
    provider: string;
    externalEventId: string;
  };
  /** Opaque upstream reference only; raw logs and incident text are deliberately excluded. */
  evidenceRef: string;
}

export interface ProductionImpact {
  state: "UNKNOWN" | "STABLE" | "DEGRADING";
  strategyDemotionRequired: boolean;
  maintenanceRecommended: boolean;
  reasons: string[];
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  return value;
};

export const productionFeedbackDigest = (feedback: ProductionFeedback): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(feedback)))
    .digest("hex");

const safe = (value: unknown, max = 2_000): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export const assertProductionFeedback: (value: unknown) => asserts value is ProductionFeedback = (
  value,
) => {
  if (!value || typeof value !== "object") throw new Error("Malformed production feedback");
  const item = value as Partial<ProductionFeedback>;
  if (
    item.schemaVersion !== 1 ||
    !safe(item.id) ||
    !safe(item.projectId) ||
    !safe(item.runId) ||
    !safe(item.candidateId) ||
    !/^[a-f0-9]{64}$/u.test(item.candidateDigest ?? "") ||
    !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(item.releaseRevision ?? "") ||
    !item.strategy ||
    !item.scope ||
    item.scope.projectId !== item.projectId ||
    !safe(item.scope.taskClass, 500) ||
    !safe(item.scope.riskProfile, 500) ||
    !["FAST", "BALANCED", "HIGH", "CRITICAL"].includes(item.scope.qualityRequirement) ||
    !safe(item.strategy.adapter, 200) ||
    !safe(item.strategy.model, 200) ||
    !safe(item.strategy.provider, 200) ||
    ![
      "INCIDENT",
      "ROLLBACK",
      "ERROR_RATE_REGRESSION",
      "LATENCY_REGRESSION",
      "SECURITY_FINDING",
    ].includes(item.type ?? "") ||
    !["LOW", "MEDIUM", "HIGH"].includes(item.severity ?? "") ||
    !safe(item.observedAt) ||
    !Number.isFinite(Date.parse(item.observedAt)) ||
    !item.source ||
    !["VERIFIED_OBSERVABILITY_ADAPTER", "SIGNED_WEBHOOK"].includes(item.source.kind) ||
    !safe(item.source.provider, 200) ||
    !safe(item.source.externalEventId, 500) ||
    !safe(item.evidenceRef)
  )
    throw new Error("Malformed production feedback");
};

export const deriveProductionImpact = (feedback: ProductionFeedback[]): ProductionImpact => {
  feedback.forEach(assertProductionFeedback);
  if (new Set(feedback.map((item) => item.projectId)).size > 1)
    throw new Error("Production impact cannot mix projects");
  if (feedback.length === 0)
    return {
      state: "UNKNOWN",
      strategyDemotionRequired: false,
      maintenanceRecommended: false,
      reasons: ["no trusted production feedback has been observed"],
    };
  const material = feedback.filter(
    (item) =>
      item.severity === "HIGH" ||
      item.type === "INCIDENT" ||
      item.type === "ROLLBACK" ||
      item.type === "SECURITY_FINDING",
  );
  return material.length
    ? {
        state: "DEGRADING",
        strategyDemotionRequired: true,
        maintenanceRecommended: true,
        reasons: material.map(
          (item) =>
            `${item.type} (${item.severity}) from ${item.source.provider}:${item.source.externalEventId}`,
        ),
      }
    : {
        state: "DEGRADING",
        strategyDemotionRequired: false,
        maintenanceRecommended: true,
        reasons: feedback.map(
          (item) =>
            `${item.type} (${item.severity}) from ${item.source.provider}:${item.source.externalEventId}`,
        ),
      };
};
