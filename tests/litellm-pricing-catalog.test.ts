import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeModelIdentity } from "../src/domain/model-intelligence";
import {
  LITELLM_PRICING_LIMITS,
  LITELLM_PRICING_PROVIDER_DESCRIPTOR,
  LiteLlmPricingCatalog,
  LiteLlmPricingCatalogLoadError,
} from "../src/infrastructure/litellm-pricing-catalog";
import { BifrostModelGateway } from "../src/infrastructure/model-gateway";

const updatedAt = "2026-08-20T00:00:00.000Z";
const loadedAt = "2026-08-21T00:00:00.000Z";
const clock = () => new Date("2026-08-22T00:00:00.000Z");

const catalog = (
  data: string | object,
  overrides: Partial<ConstructorParameters<typeof LiteLlmPricingCatalog>[0]> = {},
) =>
  new LiteLlmPricingCatalog({
    data,
    sourceVersion: "upstream-commit-abc123",
    sourceUpdatedAt: updatedAt,
    loadedAt,
    maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
    clock,
    ...overrides,
  });

const apiIdentity = (provider: string, model: string) =>
  normalizeModelIdentity({ provider, model, executionInterface: "API_GATEWAY" });

const knownPrices = {
  "openai/gpt-known": {
    litellm_provider: "openai",
    input_cost_per_token: 0.000_001,
    output_cost_per_token: 0.000_002,
    cache_read_input_token_cost: 0.000_000_1,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiteLlmPricingCatalog", () => {
  it("estimates a known API model from operator-supplied data without routing authority", () => {
    const pricing = catalog(knownPrices);
    expect(
      pricing.estimate(apiIdentity("openai", "gpt-known"), {
        input: 1_000,
        output: 200,
        cached: 0,
      }),
    ).toMatchObject({
      status: "ESTIMATED",
      amountUsd: 0.0014,
    });
    expect(pricing.metadata).toMatchObject({
      sourceVersion: "upstream-commit-abc123",
      sourceUpdatedAt: updatedAt,
      loadedAt,
      digestAlgorithm: "SHA-256",
      digestBasis: "CANONICAL_CALLER_OBJECT_UTF8",
      modelEntryCount: 1,
      indexedEntryCount: 1,
    });
    expect(LITELLM_PRICING_PROVIDER_DESCRIPTOR).toMatchObject({
      networkAccess: "NONE",
      monetaryAuthority: "ESTIMATE_ONLY",
      routingAuthority: "NONE",
    });
  });

  it("hashes the exact caller-supplied JSON bytes", () => {
    const source = ` {\n  "openai/gpt-known": ${JSON.stringify(knownPrices["openai/gpt-known"])}\n}`;
    const pricing = catalog(source);
    expect(pricing.sourceDigest).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
    expect(pricing.metadata.digestBasis).toBe("CALLER_JSON_UTF8");
  });

  it("returns reasoned UNKNOWN for an unknown model", () => {
    const result = catalog(knownPrices).estimate(apiIdentity("openai", "missing"), {
      input: 1,
      output: 1,
      cached: 0,
    });
    expect(result).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(result.source).toContain("reason=MODEL_NOT_FOUND");
  });

  it("returns reasoned UNKNOWN when the pinned source is stale", () => {
    const pricing = catalog(knownPrices, {
      maxAgeMs: 24 * 60 * 60 * 1_000,
      clock: () => new Date("2026-08-22T00:00:00.001Z"),
    });
    const result = pricing.estimate(apiIdentity("openai", "gpt-known"), {
      input: 1,
      output: 1,
      cached: 0,
    });
    expect(result).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(result.source).toContain("reason=SOURCE_STALE");
    expect(result.source).toContain(`maxAgeMs=${24 * 60 * 60 * 1_000}`);
  });

  it("fails closed when an entry carries an unimplemented automatic token-pricing tier", () => {
    const result = catalog({
      "openai/gpt-tiered": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000_001,
        output_cost_per_token: 0.000_002,
        input_cost_per_token_above_128k_tokens: 0.000_002,
      },
    }).estimate(apiIdentity("openai", "gpt-tiered"), {
      input: 1,
      output: 1,
      cached: 0,
    });

    expect(result).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(result.source).toContain("reason=UNSUPPORTED_PRICING_MODIFIER");
  });

  it("does not turn malformed JSON or malformed prices into zero", () => {
    const malformedDocument = catalog("{not-json");
    expect(
      malformedDocument.estimate(apiIdentity("openai", "gpt-known"), {
        input: 1,
        output: 1,
        cached: 0,
      }),
    ).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(
      malformedDocument.estimate(apiIdentity("openai", "gpt-known"), {
        input: 1,
        output: 1,
        cached: 0,
      }).source,
    ).toContain("reason=CATALOG_MALFORMED_JSON");

    const malformedPrice = catalog({
      "openai/gpt-known": {
        ...knownPrices["openai/gpt-known"],
        input_cost_per_token: -1,
      },
    }).estimate(apiIdentity("openai", "gpt-known"), { input: 1, output: 0, cached: 0 });
    expect(malformedPrice).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(malformedPrice.source).toContain("reason=INPUT_PRICE_MALFORMED");
  });

  it("matches provider and model together without crossing provider collisions", () => {
    const pricing = catalog({
      "openai/shared": {
        litellm_provider: "openai",
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
      },
      "anthropic/shared": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.01,
        output_cost_per_token: 0.02,
      },
    });
    expect(
      pricing.estimate(apiIdentity("openai", "shared"), { input: 1, output: 1, cached: 0 }),
    ).toMatchObject({ status: "ESTIMATED", amountUsd: 0.003 });
    expect(
      pricing.estimate(apiIdentity("anthropic", "shared"), {
        input: 1,
        output: 1,
        cached: 0,
      }),
    ).toMatchObject({ status: "ESTIMATED", amountUsd: 0.03 });
    const wrongProvider = pricing.estimate(apiIdentity("other", "shared"), {
      input: 1,
      output: 1,
      cached: 0,
    });
    expect(wrongProvider.source).toContain("reason=MODEL_NOT_FOUND");
  });

  it("prices cached tokens at cache-read price instead of charging them twice", () => {
    const result = catalog(knownPrices).estimate(apiIdentity("openai", "gpt-known"), {
      input: 1_000,
      output: 100,
      cached: 400,
    });
    expect(result).toMatchObject({ status: "ESTIMATED" });
    expect(result.amountUsd).toBeCloseTo(0.000_84, 12);
  });

  it("returns UNKNOWN when cache-read usage has no supported cache price", () => {
    const result = catalog({
      "openai/gpt-no-cache-price": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000_001,
        output_cost_per_token: 0.000_002,
      },
    }).estimate(apiIdentity("openai", "gpt-no-cache-price"), {
      input: 10,
      output: 0,
      cached: 5,
    });
    expect(result).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(result.source).toContain("reason=CACHE_READ_PRICE_UNAVAILABLE");
  });

  it("returns UNKNOWN for unsupported or internally inconsistent usage", () => {
    const pricing = catalog(knownPrices);
    const inconsistent = pricing.estimate(apiIdentity("openai", "gpt-known"), {
      input: 4,
      output: 0,
      cached: 5,
    });
    expect(inconsistent).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(inconsistent.source).toContain("reason=USAGE_CACHED_EXCEEDS_INPUT");

    const fractional = pricing.estimate(apiIdentity("openai", "gpt-known"), {
      input: 0.5,
      output: 0,
      cached: 0,
    });
    expect(fractional).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(fractional.source).toContain("reason=USAGE_INVALID");
  });

  it("does not fake a zero API estimate for native or subscription execution", () => {
    const nativeIdentity = normalizeModelIdentity({
      provider: "openai",
      model: "gpt-known",
      executionInterface: "NATIVE_CLI",
    });
    const result = catalog(knownPrices).estimate(nativeIdentity, {
      input: 0,
      output: 0,
      cached: 0,
    });
    expect(result).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(result.source).toContain("reason=UNSUPPORTED_EXECUTION_INTERFACE");
  });

  it("rejects oversized documents and unbounded model-entry sets", () => {
    expect(() => catalog(" ".repeat(LITELLM_PRICING_LIMITS.maxSourceBytes + 1))).toThrowError(
      LiteLlmPricingCatalogLoadError,
    );
    const entries = Object.fromEntries(
      Array.from({ length: LITELLM_PRICING_LIMITS.maxModelEntries + 1 }, (_, index) => [
        `provider/model-${index}`,
        { litellm_provider: "provider", input_cost_per_token: 1 },
      ]),
    );
    expect(() => catalog(entries)).toThrowError(/model entries/u);
  });

  it("leaves gateway cost UNKNOWN when no catalog is configured", async () => {
    const gateway = new BifrostModelGateway(
      { baseUrl: "http://127.0.0.1:1", maxRetries: 0, models: [] },
      { resolve: async () => "never-used" },
    );
    await expect(
      gateway.estimateCost("openai", "gpt-known", { input: 1, output: 1, cached: 0 }),
    ).resolves.toEqual({
      status: "UNKNOWN",
      amountUsd: null,
      source: "no model pricing catalog is configured",
    });
  });

  it("does not turn missing provider usage into a configured-catalog zero estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const gateway = new BifrostModelGateway(
      { baseUrl: "http://pricing-fixture.invalid", maxRetries: 0, models: ["gpt-known"] },
      { resolve: async () => "never-used" },
      catalog(knownPrices),
    );

    const result = await gateway.execute({
      provider: "openai",
      model: "gpt-known",
      messages: [{ role: "user", content: "hello" }],
      metadata: { runId: "session-8-pricing" },
    });

    expect(result.usage).toEqual({ input: 0, output: 0, cached: 0 });
    expect(result.cost).toEqual({
      status: "UNKNOWN",
      amountUsd: null,
      source: "provider token usage is unavailable or malformed",
    });
  });
});
