import type {
  CredentialResolver,
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from "../domain/ports";
import type { ModelHealth, TokenUsage } from "../domain/types";

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
        const usage: TokenUsage = {
          input: body.usage?.prompt_tokens ?? 0,
          output: body.usage?.completion_tokens ?? 0,
          cached: body.usage?.cached_tokens ?? 0,
        };
        this.health.set(request.provider, "HEALTHY");
        return {
          content: body.choices?.[0]?.message?.content ?? "",
          usage,
          cost: await this.estimateCost(request.provider, request.model, usage),
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

  async estimateCost(_provider: string, _model: string, usage: TokenUsage): Promise<number> {
    return (usage.input * 0.000_001 + usage.output * 0.000_003) / 1_000;
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
      cost: 0,
      latencyMs: 1,
      retryCount: 0,
    };
  }
  async estimateCost(): Promise<number> {
    return 0;
  }
  async getProviderHealth(): Promise<ModelHealth> {
    return "HEALTHY";
  }
}
