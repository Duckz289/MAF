import type {
  CredentialResolver,
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from "../domain/ports";
import type { ModelHealth, TokenUsage } from "../domain/types";
import {
  type ModelPricingCatalog,
  normalizeModelIdentity,
  type MonetaryCost,
  unknownMonetaryCost,
} from "../domain/model-intelligence";

interface BifrostConfig {
  baseUrl: string;
  maxRetries: number;
  models: string[];
}

export class BifrostModelGateway implements ModelGateway {
  private readonly health = new Map<string, ModelHealth>();

  constructor(
    private readonly config: BifrostConfig,
    private readonly credentials: CredentialResolver,
    private readonly pricing?: ModelPricingCatalog,
  ) {}

  async listModels(): Promise<string[]> {
    return [...this.config.models];
  }

  async execute(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    let retryCount = 0;
    let lastError: Error | undefined;
    while (retryCount <= this.config.maxRetries) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (request.credentialReference) {
          const key = await this.credentials.resolve(request.credentialReference, request.provider);
          headers.Authorization = `Bearer ${key}`;
        }
        const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            metadata: request.metadata,
          }),
        });
        if (!response.ok) throw new Error(`Bifrost responded with ${response.status}`);
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
        };
        const validTokenCount = (value: unknown): value is number =>
          Number.isSafeInteger(value) && Number(value) >= 0;
        const inputUsageValid = validTokenCount(body.usage?.prompt_tokens);
        const outputUsageValid = validTokenCount(body.usage?.completion_tokens);
        const cachedUsageValid =
          body.usage?.cached_tokens === undefined || validTokenCount(body.usage.cached_tokens);
        const usage: TokenUsage = {
          input: inputUsageValid ? (body.usage?.prompt_tokens ?? 0) : 0,
          output: outputUsageValid ? (body.usage?.completion_tokens ?? 0) : 0,
          cached: cachedUsageValid ? (body.usage?.cached_tokens ?? 0) : 0,
        };
        const cost =
          inputUsageValid && outputUsageValid && cachedUsageValid
            ? await this.estimateCost(request.provider, request.model, usage)
            : unknownMonetaryCost("provider token usage is unavailable or malformed");
        this.health.set(request.provider, "HEALTHY");
        return {
          content: body.choices?.[0]?.message?.content ?? "",
          usage,
          cost,
          latencyMs: performance.now() - started,
          retryCount,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount += 1;
        this.health.set(
          request.provider,
          retryCount > this.config.maxRetries ? "BROKEN" : "DEGRADED",
        );
      }
    }
    throw lastError ?? new Error("Bifrost request failed");
  }

  async estimateCost(provider: string, model: string, usage: TokenUsage): Promise<MonetaryCost> {
    if (!this.pricing) {
      return unknownMonetaryCost("no model pricing catalog is configured");
    }
    return this.pricing.estimate(
      normalizeModelIdentity({ provider, model, executionInterface: "API_GATEWAY" }),
      usage,
    );
  }

  async getProviderHealth(provider: string): Promise<ModelHealth> {
    return this.health.get(provider) ?? "HEALTHY";
  }
}

export class MockModelGateway implements ModelGateway {
  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
  async execute(request: ModelRequest): Promise<ModelResponse> {
    const content = request.messages.at(-1)?.content ?? "";
    return {
      content,
      usage: { input: 8, output: 8, cached: 0 },
      cost: unknownMonetaryCost("fixture gateway has no pricing catalog"),
      latencyMs: 1,
      retryCount: 0,
    };
  }
  async estimateCost(): Promise<MonetaryCost> {
    return unknownMonetaryCost("fixture gateway has no pricing catalog");
  }
  async getProviderHealth(): Promise<ModelHealth> {
    return "HEALTHY";
  }
}
