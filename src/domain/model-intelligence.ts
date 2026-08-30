import { deterministicDigest } from "./deterministic-identity";
import type { ModelHealth, TokenUsage } from "./types";

export type ModelExecutionInterface = "NATIVE_CLI" | "NATIVE_ACP" | "API_GATEWAY" | "UNKNOWN";

export interface ModelIdentity {
  provider: string;
  model: string;
  profile: string | null;
  executionInterface: ModelExecutionInterface;
}

export type MonetaryCost =
  | {
      status: "EXACT" | "ESTIMATED";
      amountUsd: number;
      source: string;
    }
  | {
      status: "SUBSCRIPTION_INCLUDED";
      amountUsd: null;
      source: string;
    }
  | {
      status: "UNKNOWN";
      amountUsd: null;
      source: string | null;
    };

export type UsageMeasurementQuality =
  | "PROVIDER_REPORTED"
  | "HARNESS_MEASURED"
  | "ESTIMATED"
  | "UNKNOWN";

export interface CanonicalCostRecord {
  model: ModelIdentity;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    quality: UsageMeasurementQuality;
  };
  monetary: MonetaryCost;
  knownSubtotalUsd: number;
  unknownComponentCount: number;
  latencyMs: number | null;
  retryCount: number;
  orchestration: {
    advisorCalls: number;
    workerCalls: number;
    verificationCalls: number;
    recoveryCalls: number;
  };
}

export interface ModelPricingCatalog {
  readonly sourceId: string;
  readonly sourceDigest: string;
  estimate(identity: ModelIdentity, usage: TokenUsage): MonetaryCost;
}

const boundedIdentityText = (label: string, value: string): void => {
  if (value.length === 0 || value.length > 256) {
    throw new Error(`${label} must contain between 1 and 256 characters`);
  }
};

export const normalizeModelIdentity = (input: {
  provider: string;
  model: string;
  profile?: string | null;
  executionInterface: ModelExecutionInterface;
}): ModelIdentity => {
  const provider = input.provider.trim().toLowerCase();
  const model = input.model.trim();
  const profile = input.profile?.trim() || null;
  boundedIdentityText("Model provider", provider);
  boundedIdentityText("Model name", model);
  if (profile !== null) boundedIdentityText("Model profile", profile);
  return { provider, model, profile, executionInterface: input.executionInterface };
};

export const modelIdentityDigest = (identity: ModelIdentity): string =>
  deterministicDigest(identity);

export const unknownMonetaryCost = (source: string | null = null): MonetaryCost => ({
  status: "UNKNOWN",
  amountUsd: null,
  source,
});

export const subscriptionMonetaryCost = (source: string): MonetaryCost => ({
  status: "SUBSCRIPTION_INCLUDED",
  amountUsd: null,
  source,
});

export const measuredMonetaryCost = (
  amountUsd: number,
  status: "EXACT" | "ESTIMATED",
  source: string,
): MonetaryCost => {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error("A monetary cost must be a finite non-negative amount");
  }
  return { status, amountUsd, source };
};

const validCount = (value: number | null): boolean =>
  value === null || (Number.isInteger(value) && value >= 0);

export const createCostRecord = (input: {
  model: ModelIdentity;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    quality: UsageMeasurementQuality;
  };
  monetary: MonetaryCost;
  latencyMs?: number | null;
  retryCount?: number;
  orchestration?: Partial<CanonicalCostRecord["orchestration"]>;
}): CanonicalCostRecord => {
  const usage = input.usage ?? {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    quality: "UNKNOWN" as const,
  };
  if (
    !validCount(usage.inputTokens) ||
    !validCount(usage.outputTokens) ||
    !validCount(usage.cachedTokens)
  ) {
    throw new Error("Token usage must be a non-negative integer or UNKNOWN");
  }
  const retryCount = input.retryCount ?? 0;
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error("Retry count must be a non-negative integer");
  }
  const latencyMs = input.latencyMs ?? null;
  if (latencyMs !== null && (!Number.isFinite(latencyMs) || latencyMs < 0)) {
    throw new Error("Latency must be non-negative or UNKNOWN");
  }
  const orchestration = {
    advisorCalls: input.orchestration?.advisorCalls ?? 0,
    workerCalls: input.orchestration?.workerCalls ?? 0,
    verificationCalls: input.orchestration?.verificationCalls ?? 0,
    recoveryCalls: input.orchestration?.recoveryCalls ?? 0,
  };
  if (Object.values(orchestration).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Orchestration counts must be non-negative integers");
  }
  return {
    model: structuredClone(input.model),
    usage: structuredClone(usage),
    monetary: structuredClone(input.monetary),
    knownSubtotalUsd: input.monetary.amountUsd ?? 0,
    unknownComponentCount: input.monetary.status === "UNKNOWN" ? 1 : 0,
    latencyMs,
    retryCount,
    orchestration,
  };
};

/** Accumulates orchestration/retry usage without laundering one unknown component into a free call. */
export const aggregateCostRecords = (
  model: ModelIdentity,
  records: CanonicalCostRecord[],
): CanonicalCostRecord => {
  const tokenField = (field: "inputTokens" | "outputTokens" | "cachedTokens"): number | null =>
    records.some((record) => record.usage[field] === null)
      ? null
      : records.reduce((sum, record) => sum + (record.usage[field] ?? 0), 0);
  const knownSubtotalUsd = records.reduce((sum, record) => sum + record.knownSubtotalUsd, 0);
  const unknownComponentCount = records.reduce(
    (sum, record) => sum + record.unknownComponentCount,
    0,
  );
  const statuses = new Set(records.map((record) => record.monetary.status));
  const monetary: MonetaryCost =
    unknownComponentCount > 0
      ? unknownMonetaryCost("one or more orchestration components have unknown monetary cost")
      : statuses.size > 0 && [...statuses].every((status) => status === "SUBSCRIPTION_INCLUDED")
        ? subscriptionMonetaryCost("all recorded calls are included in native subscriptions")
        : measuredMonetaryCost(
            knownSubtotalUsd,
            statuses.has("ESTIMATED") || statuses.has("SUBSCRIPTION_INCLUDED")
              ? "ESTIMATED"
              : "EXACT",
            "aggregate of bounded execution components",
          );
  const knownLatencies = records.flatMap((record) =>
    record.latencyMs === null ? [] : [record.latencyMs],
  );
  return {
    model: structuredClone(model),
    usage: {
      inputTokens: tokenField("inputTokens"),
      outputTokens: tokenField("outputTokens"),
      cachedTokens: tokenField("cachedTokens"),
      quality: records.every((record) => record.usage.quality === "PROVIDER_REPORTED")
        ? "PROVIDER_REPORTED"
        : records.some((record) => record.usage.quality === "UNKNOWN")
          ? "UNKNOWN"
          : "ESTIMATED",
    },
    monetary,
    knownSubtotalUsd,
    unknownComponentCount,
    latencyMs:
      knownLatencies.length === records.length
        ? knownLatencies.reduce((sum, value) => sum + value, 0)
        : null,
    retryCount: records.reduce((sum, record) => sum + record.retryCount, 0),
    orchestration: {
      advisorCalls: records.reduce((sum, record) => sum + record.orchestration.advisorCalls, 0),
      workerCalls: records.reduce((sum, record) => sum + record.orchestration.workerCalls, 0),
      verificationCalls: records.reduce(
        (sum, record) => sum + record.orchestration.verificationCalls,
        0,
      ),
      recoveryCalls: records.reduce((sum, record) => sum + record.orchestration.recoveryCalls, 0),
    },
  };
};

export interface ModelCandidate {
  identity: ModelIdentity;
  health: ModelHealth;
  qualityTier: number;
  maximumRisk: "LOW" | "MEDIUM" | "HIGH";
  monetaryCost: MonetaryCost;
  native: boolean;
  operatorPinned: boolean;
}
