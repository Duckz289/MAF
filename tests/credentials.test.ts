import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BetterAuthConfigAdapter,
  CredentialBindingStore,
  InMemoryPlatformApiKeys,
  redactSecrets,
} from "../src/infrastructure/credentials";
import {
  NativeAgentAuthManager,
  type NativeAuthProcessRunner,
  resolveCodexCommand,
} from "../src/infrastructure/native-agent-auth";
import {
  GoogleGeminiOAuth,
  LocalEncryptedCredentialVault,
  ProviderConnectionRegistry,
} from "../src/infrastructure/provider-connections";

afterEach(() => vi.unstubAllGlobals());

class FakeNativeLoginProcess extends EventEmitter {
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("credential boundary", () => {
  it("keeps an explicitly configured Codex CLI command authoritative", () => {
    expect(resolveCodexCommand("C:\\tools\\codex.exe", "C:\\unused")).toBe("C:\\tools\\codex.exe");
  });

  it("orchestrates official native login without retaining CLI output or logging out the provider", () => {
    let authenticated = false;
    const process = new FakeNativeLoginProcess();
    const runner: NativeAuthProcessRunner = {
      check: (_command, args) => {
        if (args[0] === "--version") return { available: true, output: "v1" };
        return {
          available: true,
          output: authenticated ? "authenticated ghp_TEST_MUST_NOT_LEAK" : "not authenticated",
        };
      },
      start: vi.fn(() => process),
    };
    const manager = new NativeAgentAuthManager(runner, 60_000);
    expect(manager.connection("claude-code")).toMatchObject({ status: "NOT_CONNECTED" });

    const attempt = manager.beginLogin("claude-code");
    expect(runner.start).toHaveBeenCalledWith("claude", ["auth", "login", "--claudeai"]);
    process.emit("spawn");
    expect(manager.pollLogin("claude-code", attempt.id)).toMatchObject({
      status: "WAITING_FOR_USER",
    });
    authenticated = true;
    expect(manager.pollLogin("claude-code", attempt.id)).toMatchObject({ status: "CONNECTED" });
    expect(JSON.stringify(manager.connection("claude-code"))).not.toContain(
      "ghp_TEST_MUST_NOT_LEAK",
    );

    manager.disconnectFromMaf("claude-code");
    expect(manager.connection("claude-code")).toMatchObject({ status: "NOT_CONNECTED" });
    expect(authenticated).toBe(true);
  });

  it("bounds and cancels native login attempts and reports a missing CLI honestly", () => {
    vi.useFakeTimers();
    const process = new FakeNativeLoginProcess();
    const runner: NativeAuthProcessRunner = {
      check: () => ({ available: true, output: "not authenticated" }),
      start: () => process,
    };
    const manager = new NativeAgentAuthManager(runner, 1_000);
    const attempt = manager.beginLogin("codex-cli");
    vi.advanceTimersByTime(1_001);
    expect(manager.pollLogin("codex-cli", attempt.id)).toMatchObject({ status: "LOGIN_EXPIRED" });
    expect(process.killed).toBe(true);

    const unavailable = new NativeAgentAuthManager({
      check: () => ({ available: false, output: "" }),
      start: () => process,
    });
    expect(unavailable.connection("codex-cli")).toMatchObject({ status: "CLI_UNAVAILABLE" });
    expect(() => unavailable.beginLogin("codex-cli")).toThrow("CLI_UNAVAILABLE");
    vi.useRealTimers();
  });

  it("explains that a Windows Desktop executable is not a supported server bridge", () => {
    const unavailable = new NativeAgentAuthManager({
      check: () => ({ available: false, output: "", failure: "ACCESS_DENIED" }),
      start: () => new FakeNativeLoginProcess(),
    });
    const connection = unavailable.connection("codex-cli");
    expect(connection).toMatchObject({ status: "CLI_UNAVAILABLE" });
    expect(connection.detail).toContain("Codex Desktop");
    expect(connection.detail).not.toMatch(/token|cookie|stdout|stderr/iu);
  });

  it("detects Antigravity's IDE-owned session without reading credentials or inventing a CLI login", () => {
    const runner: NativeAuthProcessRunner = {
      check: () => ({ available: true, output: "agy 1.1.13" }),
      start: vi.fn(() => new FakeNativeLoginProcess()),
    };
    const manager = new NativeAgentAuthManager(runner);
    expect(manager.connection("antigravity-cli")).toMatchObject({
      status: "CLI_READY",
      connectionReference: "connection://antigravity/native",
      authCapabilities: expect.objectContaining({ supportsNativeLogin: false }),
    });
    expect(() => manager.beginLogin("antigravity-cli")).toThrow("ANTIGRAVITY_IDE_LOGIN_REQUIRED");
    expect(runner.start).not.toHaveBeenCalled();
    expect(JSON.stringify(manager.connection("antigravity-cli"))).not.toMatch(
      /access-token-secret|refresh-token-secret|session-cookie-secret/iu,
    );
  });

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
    expect(() =>
      store.add({
        id: "smuggled-binding",
        ownerId: "owner",
        provider: "openai",
        strategy: "USER_API_KEY",
        credentialReference: "credential://owner/ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
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

  it("auto-provisions a process-local encrypted vault without exposing API keys", () => {
    const vault = new LocalEncryptedCredentialVault();
    expect(vault.available()).toBe(true);
    expect(vault.storageDetail()).toContain("tạo tự động");
    const registry = new ProviderConnectionRegistry(vault);
    const configured = registry.configureVault("owner", "openai", "sk-not-exposed-to-the-client");
    expect(configured).toMatchObject({
      id: "openai-api",
      status: "CONFIGURED",
      credentialReference: expect.stringMatching(/^credential:\/\/local-vault\//u),
    });
    expect(JSON.stringify(configured)).not.toContain("sk-not-exposed-to-the-client");
  });

  it("builds a stateful PKCE Google OAuth URL only when an encrypted vault is available", () => {
    const oauth = new GoogleGeminiOAuth(
      new LocalEncryptedCredentialVault("a-test-only-vault-master-key-with-32-chars"),
      "google-client-id.apps.googleusercontent.com",
      undefined,
      "http://127.0.0.1:4310",
    );
    const url = new URL(oauth.start("owner"));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4310/api/v1/connections/oauth/google/callback",
    );
  });

  it("refreshes an expired Google OAuth token inside the vault without exposing it", async () => {
    const vault = new LocalEncryptedCredentialVault("a-test-only-vault-master-key-with-32-chars");
    const oauth = new GoogleGeminiOAuth(vault, "client-id", "client-secret");
    const expired = vault.put(
      JSON.stringify({
        accessToken: "expired-access-token",
        refreshToken: "refresh-token",
        expiresAt: 0,
      }),
    );
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 3600 }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const refreshed = await oauth.refresh(expired);
    expect(refreshed).not.toBe(expired);
    expect(vault.get(expired)).toBeUndefined();
    expect(vault.get(refreshed)).toContain("new-access-token");
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps Gemini account OAuth separate from Gemini API key configuration", async () => {
    const vault = new LocalEncryptedCredentialVault("a-test-only-vault-master-key-with-32-chars");
    const oauth = new GoogleGeminiOAuth(vault, "client-id", "client-secret");
    const registry = new ProviderConnectionRegistry(vault, oauth);
    const authorizationUrl = new URL(registry.beginGoogleAccountOAuth("owner"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "google-access-token", expires_in: 3600 }), {
            status: 200,
          }),
      ),
    );
    await registry.completeGoogleOAuth(authorizationUrl.searchParams.get("state") ?? "", "code");
    expect(registry.account("owner")).toMatchObject({
      id: "gemini-account",
      category: "ACCOUNT_AGENT",
      status: "CONNECTED",
      connectionReference: "connection://gemini/google-account",
    });
    expect(registry.list("owner")).toContainEqual(
      expect.objectContaining({ id: "gemini-api", status: "NOT_CONFIGURED" }),
    );
    expect(JSON.stringify(registry.account("owner"))).not.toContain("google-access-token");
    await expect(registry.completeGoogleOAuth("invalid", "code")).rejects.toThrow(
      "OAuth state is invalid or expired",
    );
  });

  it("does not report a missing Google OAuth client as a user login failure", () => {
    const registry = new ProviderConnectionRegistry(new LocalEncryptedCredentialVault());
    expect(registry.account("owner")).toMatchObject({
      id: "gemini-account",
      status: "OAUTH_CONFIGURATION_REQUIRED",
    });
    expect(registry.account("owner").detail).toContain("không phải lỗi đăng nhập");
  });

  it("tests a custom OpenAI-compatible endpoint without exposing API keys or secret headers", async () => {
    const registry = new ProviderConnectionRegistry(
      new LocalEncryptedCredentialVault("a-test-only-vault-master-key-with-32-chars"),
    );
    const connection = registry.configureCustom("owner", {
      name: "Private gateway",
      protocol: "OPENAI_COMPATIBLE",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-custom-endpoint-secret",
      model: "frontier",
      headers: [
        { name: "X-Project-ID", value: "project-public", classification: "PUBLIC" },
        { name: "X-Gateway-Key", value: "gateway-secret", classification: "SECRET" },
      ],
    });
    expect(JSON.stringify(connection)).not.toContain("sk-custom-endpoint-secret");
    expect(JSON.stringify(connection)).not.toContain("gateway-secret");
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: "frontier" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);

    const tested = await registry.test("owner", connection.id);
    expect(tested).toMatchObject({ status: "CONNECTED", models: ["frontier"] });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://gateway.example/v1/models"),
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-custom-endpoint-secret",
          "X-Project-ID": "project-public",
          "X-Gateway-Key": "gateway-secret",
        }),
      }),
    );
    registry.disconnect("owner", connection.id);
    expect(registry.list("owner")).not.toContainEqual(
      expect.objectContaining({ id: connection.id }),
    );
  });

  it("supports Anthropic-compatible endpoint checks and refuses unsafe URLs or redirects", async () => {
    const registry = new ProviderConnectionRegistry(
      new LocalEncryptedCredentialVault("a-test-only-vault-master-key-with-32-chars"),
    );
    expect(() =>
      registry.configureCustom("owner", {
        name: "Unsafe",
        protocol: "OPENAI_COMPATIBLE",
        baseUrl: "http://gateway.internal/v1",
        apiKey: "key",
        model: "model",
      }),
    ).toThrow("HTTPS");
    const connection = registry.configureCustom("owner", {
      name: "Anthropic proxy",
      protocol: "ANTHROPIC_COMPATIBLE",
      baseUrl: "https://anthropic.example/v1",
      apiKey: "anthropic-secret",
      model: "claude-proxy",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://elsewhere.example/models" },
          }),
      ),
    );
    await expect(registry.test("owner", connection.id)).resolves.toMatchObject({
      status: "PROTOCOL_INCOMPATIBLE",
    });
  });
});
