import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialResolver } from "../src/domain/ports";
import { BifrostModelGateway } from "../src/infrastructure/model-gateway";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("BifrostModelGateway", () => {
  it("resolves credential references at the edge and applies bounded retry", async () => {
    let attempts = 0;
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      attempts += 1;
      authorizations.push(request.headers.authorization);
      if (attempts === 1) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 5 },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const resolver: CredentialResolver = {
      resolve: async (reference, provider) => {
        expect(reference).toBe("credential://owner/openai");
        expect(provider).toBe("openai");
        return "test-secret-at-edge";
      },
    };
    const gateway = new BifrostModelGateway(
      { baseUrl: `http://127.0.0.1:${port}`, maxRetries: 1, models: ["openai/test"] },
      resolver,
    );
    const result = await gateway.execute({
      provider: "openai",
      model: "openai/test",
      messages: [{ role: "user", content: "hello" }],
      credentialReference: "credential://owner/openai",
      metadata: { runId: "run" },
    });
    expect(result).toMatchObject({ content: "ok", retryCount: 1 });
    expect(result.usage).toEqual({ input: 100, output: 20, cached: 5 });
    expect(authorizations).toEqual(["Bearer test-secret-at-edge", "Bearer test-secret-at-edge"]);
    expect(await gateway.getProviderHealth("openai")).toBe("HEALTHY");
  });
});
