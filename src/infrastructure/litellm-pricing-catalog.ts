import { createHash } from "node:crypto";
import {
  type ModelIdentity,
  type ModelPricingCatalog,
  type MonetaryCost,
  measuredMonetaryCost,
  unknownMonetaryCost,
} from "../domain/model-intelligence";
import type { TokenUsage } from "../domain/types";

export const LITELLM_PRICING_LIMITS = Object.freeze({
  maxSourceBytes: 8 * 1024 * 1024,
  maxModelEntries: 10_000,
  maxEntryFields: 256,
  maxJsonDepth: 24,
  maxJsonNodes: 500_000,
  maxStringBytes: 64 * 1024,
});

export const LITELLM_PRICING_PROVIDER_DESCRIPTOR = Object.freeze({
  id: "litellm-model-prices-and-context-window",
  kind: "MODEL_PRICING_CATALOG",
  integration: "OPERATOR_SUPPLIED_DATA_ONLY",
  networkAccess: "NONE",
  monetaryAuthority: "ESTIMATE_ONLY",
  routingAuthority: "NONE",
  sourceIntegrity: "SHA-256",
  supportedExecutionInterfaces: Object.freeze(["API_GATEWAY"] as const),
});

export type LiteLlmPricingUnknownReason =
  | "AMBIGUOUS_PROVIDER_MODEL"
  | "CACHE_READ_PRICE_MALFORMED"
  | "CACHE_READ_PRICE_UNAVAILABLE"
  | "CATALOG_MALFORMED_DOCUMENT"
  | "CATALOG_MALFORMED_JSON"
  | "CLOCK_BEFORE_LOAD_TIME"
  | "CLOCK_UNAVAILABLE"
  | "INPUT_PRICE_MALFORMED"
  | "INPUT_PRICE_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "OUTPUT_PRICE_MALFORMED"
  | "OUTPUT_PRICE_UNAVAILABLE"
  | "SOURCE_STALE"
  | "UNSUPPORTED_EXECUTION_INTERFACE"
  | "UNSUPPORTED_MODEL_PROFILE"
  | "UNSUPPORTED_PRICING_MODIFIER"
  | "USAGE_CACHED_EXCEEDS_INPUT"
  | "USAGE_INVALID"
  | "USAGE_NOT_PRICEABLE";

export type LiteLlmPricingLoadErrorCode =
  | "ENTRY_FIELD_LIMIT_EXCEEDED"
  | "INVALID_JSON_OBJECT"
  | "JSON_DEPTH_LIMIT_EXCEEDED"
  | "JSON_NODE_LIMIT_EXCEEDED"
  | "MODEL_ENTRY_LIMIT_EXCEEDED"
  | "SOURCE_SIZE_LIMIT_EXCEEDED"
  | "STRING_SIZE_LIMIT_EXCEEDED";

export class LiteLlmPricingCatalogLoadError extends Error {
  override readonly name = "LiteLlmPricingCatalogLoadError";

  constructor(
    readonly code: LiteLlmPricingLoadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LiteLlmPricingCatalogOptions {
  data: string | object;
  sourceVersion: string;
  sourceUpdatedAt: string | Date;
  loadedAt: string | Date;
  maxAgeMs: number;
  clock?: () => Date;
}

export interface LiteLlmPricingCatalogMetadata {
  readonly sourceVersion: string;
  readonly sourceUpdatedAt: string;
  readonly loadedAt: string;
  readonly maxAgeMs: number;
  readonly sourceBytes: number;
  readonly digestAlgorithm: "SHA-256";
  readonly digestBasis: "CALLER_JSON_UTF8" | "CANONICAL_CALLER_OBJECT_UTF8";
  readonly modelEntryCount: number;
  readonly indexedEntryCount: number;
  readonly rejectedEntryCount: number;
}

type PriceField =
  | { status: "AVAILABLE"; value: number }
  | { status: "MALFORMED" }
  | { status: "UNAVAILABLE" };

interface PricingEntry {
  provider: string;
  rawModel: string;
  input: PriceField;
  output: PriceField;
  cacheRead: PriceField;
  unsupportedPricingModifier: boolean;
}

interface ParsedCatalog {
  exact: Map<string, PricingEntry[]>;
  aliases: Map<string, PricingEntry[]>;
  loadFailure: LiteLlmPricingUnknownReason | null;
  modelEntryCount: number;
  indexedEntryCount: number;
  rejectedEntryCount: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const checkedInstant = (label: string, value: string | Date): Date => {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid instant`);
  return parsed;
};

const checkedVersion = (value: string): string => {
  const version = value.trim();
  if (version.length === 0 || version.length > 256) {
    throw new Error("LiteLLM pricing source version must contain between 1 and 256 characters");
  }
  return version;
};

const checkedMaxAge = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("LiteLLM pricing maxAgeMs must be a non-negative safe integer");
  }
  return value;
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const addBoundedChunk = (chunks: string[], state: { bytes: number }, value: string): void => {
  state.bytes += Buffer.byteLength(value, "utf8");
  if (state.bytes > LITELLM_PRICING_LIMITS.maxSourceBytes) {
    throw new LiteLlmPricingCatalogLoadError(
      "SOURCE_SIZE_LIMIT_EXCEEDED",
      `LiteLLM pricing source exceeds ${LITELLM_PRICING_LIMITS.maxSourceBytes} UTF-8 bytes`,
    );
  }
  chunks.push(value);
};

/** Canonicalizes a caller-supplied object because no original source bytes exist for an object. */
const canonicalizeBoundedJson = (root: object): string => {
  const chunks: string[] = [];
  const byteState = { bytes: 0 };
  const ancestors = new WeakSet<object>();
  let nodeCount = 0;

  const write = (value: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > LITELLM_PRICING_LIMITS.maxJsonNodes) {
      throw new LiteLlmPricingCatalogLoadError(
        "JSON_NODE_LIMIT_EXCEEDED",
        `LiteLLM pricing source exceeds ${LITELLM_PRICING_LIMITS.maxJsonNodes} JSON nodes`,
      );
    }
    if (depth > LITELLM_PRICING_LIMITS.maxJsonDepth) {
      throw new LiteLlmPricingCatalogLoadError(
        "JSON_DEPTH_LIMIT_EXCEEDED",
        `LiteLLM pricing source exceeds JSON depth ${LITELLM_PRICING_LIMITS.maxJsonDepth}`,
      );
    }
    if (value === null || typeof value === "boolean") {
      addBoundedChunk(chunks, byteState, String(value));
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new LiteLlmPricingCatalogLoadError(
          "INVALID_JSON_OBJECT",
          "Caller-supplied LiteLLM pricing object contains a non-finite number",
        );
      }
      addBoundedChunk(chunks, byteState, JSON.stringify(value));
      return;
    }
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > LITELLM_PRICING_LIMITS.maxStringBytes) {
        throw new LiteLlmPricingCatalogLoadError(
          "STRING_SIZE_LIMIT_EXCEEDED",
          `LiteLLM pricing source contains a string over ${LITELLM_PRICING_LIMITS.maxStringBytes} UTF-8 bytes`,
        );
      }
      addBoundedChunk(chunks, byteState, JSON.stringify(value));
      return;
    }
    if (typeof value !== "object" || value === null) {
      throw new LiteLlmPricingCatalogLoadError(
        "INVALID_JSON_OBJECT",
        "Caller-supplied LiteLLM pricing object must contain JSON values only",
      );
    }
    if (ancestors.has(value)) {
      throw new LiteLlmPricingCatalogLoadError(
        "INVALID_JSON_OBJECT",
        "Caller-supplied LiteLLM pricing object must not contain cycles",
      );
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      addBoundedChunk(chunks, byteState, "[");
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new LiteLlmPricingCatalogLoadError(
            "INVALID_JSON_OBJECT",
            "Caller-supplied LiteLLM pricing arrays must not contain holes",
          );
        }
        if (index > 0) addBoundedChunk(chunks, byteState, ",");
        write(value[index], depth + 1);
      }
      addBoundedChunk(chunks, byteState, "]");
      ancestors.delete(value);
      return;
    }
    if (!isPlainRecord(value)) {
      throw new LiteLlmPricingCatalogLoadError(
        "INVALID_JSON_OBJECT",
        "Caller-supplied LiteLLM pricing data must use plain JSON objects",
      );
    }
    addBoundedChunk(chunks, byteState, "{");
    const keys = Object.keys(value).sort();
    for (const [index, key] of keys.entries()) {
      if (Buffer.byteLength(key, "utf8") > LITELLM_PRICING_LIMITS.maxStringBytes) {
        throw new LiteLlmPricingCatalogLoadError(
          "STRING_SIZE_LIMIT_EXCEEDED",
          `LiteLLM pricing source contains a key over ${LITELLM_PRICING_LIMITS.maxStringBytes} UTF-8 bytes`,
        );
      }
      if (index > 0) addBoundedChunk(chunks, byteState, ",");
      addBoundedChunk(chunks, byteState, `${JSON.stringify(key)}:`);
      write(value[key], depth + 1);
    }
    addBoundedChunk(chunks, byteState, "}");
    ancestors.delete(value);
  };

  write(root, 0);
  return chunks.join("");
};

const assertBoundedParsedJson = (root: unknown): void => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodeCount += 1;
    if (nodeCount > LITELLM_PRICING_LIMITS.maxJsonNodes) {
      throw new LiteLlmPricingCatalogLoadError(
        "JSON_NODE_LIMIT_EXCEEDED",
        `LiteLLM pricing source exceeds ${LITELLM_PRICING_LIMITS.maxJsonNodes} JSON nodes`,
      );
    }
    if (current.depth > LITELLM_PRICING_LIMITS.maxJsonDepth) {
      throw new LiteLlmPricingCatalogLoadError(
        "JSON_DEPTH_LIMIT_EXCEEDED",
        `LiteLLM pricing source exceeds JSON depth ${LITELLM_PRICING_LIMITS.maxJsonDepth}`,
      );
    }
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > LITELLM_PRICING_LIMITS.maxStringBytes) {
        throw new LiteLlmPricingCatalogLoadError(
          "STRING_SIZE_LIMIT_EXCEEDED",
          `LiteLLM pricing source contains a string over ${LITELLM_PRICING_LIMITS.maxStringBytes} UTF-8 bytes`,
        );
      }
      continue;
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new LiteLlmPricingCatalogLoadError(
        "INVALID_JSON_OBJECT",
        "LiteLLM pricing source contains a non-finite number",
      );
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 });
      continue;
    }
    if (isPlainRecord(current.value)) {
      for (const [key, value] of Object.entries(current.value)) {
        if (Buffer.byteLength(key, "utf8") > LITELLM_PRICING_LIMITS.maxStringBytes) {
          throw new LiteLlmPricingCatalogLoadError(
            "STRING_SIZE_LIMIT_EXCEEDED",
            `LiteLLM pricing source contains a key over ${LITELLM_PRICING_LIMITS.maxStringBytes} UTF-8 bytes`,
          );
        }
        pending.push({ value, depth: current.depth + 1 });
      }
    }
  }
};

const priceField = (entry: Record<string, unknown>, field: string): PriceField => {
  if (!Object.hasOwn(entry, field)) return { status: "UNAVAILABLE" };
  const value = entry[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { status: "AVAILABLE", value }
    : { status: "MALFORMED" };
};

const automaticTokenTier =
  /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_[0-9]+k_tokens(?:$|_)/u;

const identityKey = (provider: string, model: string): string =>
  `${provider.length}:${provider}:${model.length}:${model}`;

const addIndexEntry = (
  index: Map<string, PricingEntry[]>,
  provider: string,
  model: string,
  entry: PricingEntry,
): void => {
  const key = identityKey(provider, model);
  const entries = index.get(key) ?? [];
  entries.push(entry);
  index.set(key, entries);
};

const parseCatalog = (document: unknown): ParsedCatalog => {
  const parsed: ParsedCatalog = {
    exact: new Map(),
    aliases: new Map(),
    loadFailure: null,
    modelEntryCount: 0,
    indexedEntryCount: 0,
    rejectedEntryCount: 0,
  };
  if (!isPlainRecord(document)) {
    parsed.loadFailure = "CATALOG_MALFORMED_DOCUMENT";
    return parsed;
  }
  const entries = Object.entries(document);
  if (entries.length > LITELLM_PRICING_LIMITS.maxModelEntries) {
    throw new LiteLlmPricingCatalogLoadError(
      "MODEL_ENTRY_LIMIT_EXCEEDED",
      `LiteLLM pricing source exceeds ${LITELLM_PRICING_LIMITS.maxModelEntries} model entries`,
    );
  }
  parsed.modelEntryCount = entries.length;
  for (const [rawModelValue, rawEntry] of entries) {
    const rawModel = rawModelValue.trim();
    if (!isPlainRecord(rawEntry)) {
      parsed.rejectedEntryCount += 1;
      continue;
    }
    if (Object.keys(rawEntry).length > LITELLM_PRICING_LIMITS.maxEntryFields) {
      throw new LiteLlmPricingCatalogLoadError(
        "ENTRY_FIELD_LIMIT_EXCEEDED",
        `LiteLLM pricing entry ${JSON.stringify(rawModel)} exceeds ${LITELLM_PRICING_LIMITS.maxEntryFields} fields`,
      );
    }
    const providerValue = rawEntry.litellm_provider;
    const provider = typeof providerValue === "string" ? providerValue.trim().toLowerCase() : "";
    if (
      rawModel.length === 0 ||
      rawModel.length > 256 ||
      provider.length === 0 ||
      provider.length > 256
    ) {
      parsed.rejectedEntryCount += 1;
      continue;
    }
    const entry: PricingEntry = {
      provider,
      rawModel,
      input: priceField(rawEntry, "input_cost_per_token"),
      output: priceField(rawEntry, "output_cost_per_token"),
      cacheRead: priceField(rawEntry, "cache_read_input_token_cost"),
      unsupportedPricingModifier: Object.keys(rawEntry).some((key) => automaticTokenTier.test(key)),
    };
    addIndexEntry(parsed.exact, provider, rawModel, entry);
    const prefix = `${provider}/`;
    if (rawModel.startsWith(prefix) && rawModel.length > prefix.length) {
      addIndexEntry(parsed.aliases, provider, rawModel.slice(prefix.length), entry);
    }
    parsed.indexedEntryCount += 1;
  }
  return parsed;
};

const validUsage = (usage: TokenUsage): boolean =>
  [usage.input, usage.output, usage.cached].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );

export class LiteLlmPricingCatalog implements ModelPricingCatalog {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly metadata: LiteLlmPricingCatalogMetadata;

  private readonly clock: () => Date;
  private readonly sourceUpdatedAtMs: number;
  private readonly loadedAtMs: number;
  private readonly catalog: ParsedCatalog;

  constructor(options: LiteLlmPricingCatalogOptions) {
    const sourceVersion = checkedVersion(options.sourceVersion);
    const sourceUpdatedAt = checkedInstant(
      "LiteLLM pricing sourceUpdatedAt",
      options.sourceUpdatedAt,
    );
    const loadedAt = checkedInstant("LiteLLM pricing loadedAt", options.loadedAt);
    if (sourceUpdatedAt.getTime() > loadedAt.getTime()) {
      throw new Error("LiteLLM pricing sourceUpdatedAt must not be later than loadedAt");
    }
    const maxAgeMs = checkedMaxAge(options.maxAgeMs);
    this.clock = options.clock ?? (() => new Date());
    this.sourceUpdatedAtMs = sourceUpdatedAt.getTime();
    this.loadedAtMs = loadedAt.getTime();

    let document: unknown;
    let sourceText: string;
    let digestBasis: LiteLlmPricingCatalogMetadata["digestBasis"];
    let malformedJson = false;
    if (typeof options.data === "string") {
      const sourceBytes = Buffer.byteLength(options.data, "utf8");
      if (sourceBytes > LITELLM_PRICING_LIMITS.maxSourceBytes) {
        throw new LiteLlmPricingCatalogLoadError(
          "SOURCE_SIZE_LIMIT_EXCEEDED",
          `LiteLLM pricing source exceeds ${LITELLM_PRICING_LIMITS.maxSourceBytes} UTF-8 bytes`,
        );
      }
      sourceText = options.data;
      digestBasis = "CALLER_JSON_UTF8";
      try {
        document = JSON.parse(sourceText) as unknown;
        assertBoundedParsedJson(document);
      } catch (error) {
        if (error instanceof LiteLlmPricingCatalogLoadError) throw error;
        malformedJson = true;
        document = null;
      }
    } else {
      sourceText = canonicalizeBoundedJson(options.data);
      digestBasis = "CANONICAL_CALLER_OBJECT_UTF8";
      document = options.data;
    }

    this.sourceDigest = sha256(sourceText);
    this.sourceId = `litellm:model_prices_and_context_window:${sourceVersion}`;
    this.catalog = malformedJson
      ? {
          exact: new Map(),
          aliases: new Map(),
          loadFailure: "CATALOG_MALFORMED_JSON",
          modelEntryCount: 0,
          indexedEntryCount: 0,
          rejectedEntryCount: 0,
        }
      : parseCatalog(document);
    this.metadata = Object.freeze({
      sourceVersion,
      sourceUpdatedAt: sourceUpdatedAt.toISOString(),
      loadedAt: loadedAt.toISOString(),
      maxAgeMs,
      sourceBytes: Buffer.byteLength(sourceText, "utf8"),
      digestAlgorithm: "SHA-256",
      digestBasis,
      modelEntryCount: this.catalog.modelEntryCount,
      indexedEntryCount: this.catalog.indexedEntryCount,
      rejectedEntryCount: this.catalog.rejectedEntryCount,
    });
  }

  estimate(identity: ModelIdentity, usage: TokenUsage): MonetaryCost {
    if (identity.executionInterface !== "API_GATEWAY") {
      return this.unknown("UNSUPPORTED_EXECUTION_INTERFACE");
    }
    if (identity.profile !== null) return this.unknown("UNSUPPORTED_MODEL_PROFILE");
    if (this.catalog.loadFailure) return this.unknown(this.catalog.loadFailure);
    let now: Date;
    try {
      now = this.clock();
    } catch {
      return this.unknown("CLOCK_UNAVAILABLE");
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return this.unknown("CLOCK_UNAVAILABLE");
    }
    if (now.getTime() < this.loadedAtMs) return this.unknown("CLOCK_BEFORE_LOAD_TIME");
    if (now.getTime() - this.sourceUpdatedAtMs > this.metadata.maxAgeMs) {
      return this.unknown("SOURCE_STALE");
    }
    if (!validUsage(usage)) return this.unknown("USAGE_INVALID");
    if (usage.cached > usage.input) return this.unknown("USAGE_CACHED_EXCEEDS_INPUT");

    const provider = identity.provider.trim().toLowerCase();
    const model = identity.model.trim();
    if (
      provider.length === 0 ||
      provider.length > 256 ||
      model.length === 0 ||
      model.length > 256
    ) {
      return this.unknown("MODEL_NOT_FOUND");
    }
    const entries = this.resolveEntries(provider, model);
    if (entries.length === 0) return this.unknown("MODEL_NOT_FOUND");
    if (entries.length !== 1) return this.unknown("AMBIGUOUS_PROVIDER_MODEL");
    const entry = entries[0];
    if (!entry) return this.unknown("MODEL_NOT_FOUND");
    if (entry.unsupportedPricingModifier) {
      return this.unknown("UNSUPPORTED_PRICING_MODIFIER");
    }

    const uncachedInput = usage.input - usage.cached;
    const components: Array<{
      tokens: number;
      price: PriceField;
      missing: LiteLlmPricingUnknownReason;
      malformed: LiteLlmPricingUnknownReason;
    }> = [
      {
        tokens: uncachedInput,
        price: entry.input,
        missing: "INPUT_PRICE_UNAVAILABLE",
        malformed: "INPUT_PRICE_MALFORMED",
      },
      {
        tokens: usage.output,
        price: entry.output,
        missing: "OUTPUT_PRICE_UNAVAILABLE",
        malformed: "OUTPUT_PRICE_MALFORMED",
      },
      {
        tokens: usage.cached,
        price: entry.cacheRead,
        missing: "CACHE_READ_PRICE_UNAVAILABLE",
        malformed: "CACHE_READ_PRICE_MALFORMED",
      },
    ];
    for (const component of components) {
      if (component.price.status === "MALFORMED") return this.unknown(component.malformed);
      if (component.tokens > 0 && component.price.status === "UNAVAILABLE") {
        return this.unknown(component.missing);
      }
    }
    if (
      usage.input === 0 &&
      usage.output === 0 &&
      entry.input.status !== "AVAILABLE" &&
      entry.output.status !== "AVAILABLE"
    ) {
      return this.unknown("USAGE_NOT_PRICEABLE");
    }

    const amountUsd = components.reduce(
      (total, component) =>
        total +
        (component.price.status === "AVAILABLE" ? component.tokens * component.price.value : 0),
      0,
    );
    if (!Number.isFinite(amountUsd) || amountUsd < 0) return this.unknown("USAGE_NOT_PRICEABLE");
    return measuredMonetaryCost(amountUsd, "ESTIMATED", this.source("PRICE_ESTIMATE"));
  }

  private resolveEntries(provider: string, model: string): PricingEntry[] {
    const found = new Set<PricingEntry>();
    const collect = (entries: PricingEntry[] | undefined): void => {
      for (const entry of entries ?? []) found.add(entry);
    };
    collect(this.catalog.exact.get(identityKey(provider, model)));
    if (found.size === 0) collect(this.catalog.aliases.get(identityKey(provider, model)));
    const prefix = `${provider}/`;
    if (found.size === 0 && model.startsWith(prefix) && model.length > prefix.length) {
      const unprefixed = model.slice(prefix.length);
      collect(this.catalog.exact.get(identityKey(provider, unprefixed)));
      collect(this.catalog.aliases.get(identityKey(provider, unprefixed)));
    }
    return [...found];
  }

  private unknown(reason: LiteLlmPricingUnknownReason): MonetaryCost {
    return unknownMonetaryCost(this.source(reason));
  }

  private source(reason: LiteLlmPricingUnknownReason | "PRICE_ESTIMATE"): string {
    return `${this.sourceId};sha256=${this.sourceDigest};updatedAt=${this.metadata.sourceUpdatedAt};loadedAt=${this.metadata.loadedAt};maxAgeMs=${this.metadata.maxAgeMs};reason=${reason}`;
  }
}
