import { describe, expect, it } from "vitest";
import {
  BetterAuthConfigAdapter,
  CredentialBindingStore,
  InMemoryPlatformApiKeys,
  redactSecrets,
} from "../src/infrastructure/credentials";

describe("credential boundary", () => {
  it("stores references and rejects raw values", () => {
    const store = new CredentialBindingStore();
    expect(() =>
      store.add({
        id: "binding",
        ownerId: "owner",
        provider: "openai",
        strategy: "USER_API_KEY",
        credentialReference: "sk-raw",
        scope: ["models.execute"],
        status: "ACTIVE",
        metadata: {},
      }),
    ).toThrow("references");
  });

  it("redacts secret-shaped fields but preserves references", () => {
    expect(
      redactSecrets({
        apiKey: "raw",
        credentialReference: "credential://owner/key",
        nested: { token: "raw" },
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      credentialReference: "credential://owner/key",
      nested: { token: "[REDACTED]" },
    });
  });

  it("issues, verifies, scopes, and revokes platform keys", async () => {
    const provider = new InMemoryPlatformApiKeys();
    const issued = await provider.issue("owner", ["runs.create"]);
    expect(await provider.verify(issued.key, "runs.create")).toBe(true);
    expect(await provider.verify(issued.key, "runs.delete")).toBe(false);
    await provider.revoke(issued.id);
    expect(await provider.verify(issued.key, "runs.create")).toBe(false);
  });

  it("constructs a real Better Auth runtime without exposing secret values in config", async () => {
    const adapter = new BetterAuthConfigAdapter();
    const config = adapter.config("http://127.0.0.1:4310");
    expect(JSON.stringify(config)).not.toContain("a-real-secret");
    const runtime = await adapter.createRuntime("http://127.0.0.1:4310", {
      secret: "test-only-secret-value-with-32-characters",
    });
    expect(runtime.handler).toBeTypeOf("function");
  });
});
