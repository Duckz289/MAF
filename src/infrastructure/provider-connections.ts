import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { CredentialBinding } from "../domain/ports";
import { CredentialBindingStore } from "./credentials";

export const apiProviderIds = ["openai", "anthropic", "gemini", "xai", "zai"] as const;
export type ApiProviderId = (typeof apiProviderIds)[number];
export type ProviderCredentialSource = "ENVIRONMENT" | "LOCAL_ENCRYPTED_VAULT" | "OAUTH_PKCE";
export type EndpointProtocol = "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";

export interface CustomHeaderInput {
  name: string;
  value: string;
  classification: "PUBLIC" | "SECRET";
}

export interface CustomEndpointInput {
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: CustomHeaderInput[];
  timeoutMs?: number;
}

interface ProviderDefinition {
  id: ApiProviderId;
  displayName: string;
  environmentVariable: string;
  apiKeyDetail: string;
  preset: {
    protocol: "OPENAI_COMPATIBLE" | "ANTHROPIC_NATIVE" | "GEMINI_REST";
    baseUrl: string;
    credentialHeader: string;
  };
}

const providerDefinitions: readonly ProviderDefinition[] = [
  {
    id: "openai",
    displayName: "OpenAI API",
    environmentVariable: "OPENAI_API_KEY",
    apiKeyDetail: "Dùng API key riêng; phiên ChatGPT không được dùng làm API credential.",
    preset: {
      protocol: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.openai.com/v1",
      credentialHeader: "Authorization: Bearer",
    },
  },
  {
    id: "anthropic",
    displayName: "Anthropic API",
    environmentVariable: "ANTHROPIC_API_KEY",
    apiKeyDetail: "Dùng Anthropic API key. Claude Code có thể dùng phiên native riêng.",
    preset: {
      protocol: "ANTHROPIC_NATIVE",
      baseUrl: "https://api.anthropic.com/v1",
      credentialHeader: "x-api-key",
    },
  },
  {
    id: "gemini",
    displayName: "Google Gemini API",
    environmentVariable: "GEMINI_API_KEY",
    apiKeyDetail: "Dùng Gemini API key riêng. Tài khoản Google OAuth là một kết nối account khác.",
    preset: {
      protocol: "GEMINI_REST",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      credentialHeader: "x-goog-api-key",
    },
  },
  {
    id: "xai",
    displayName: "xAI Grok API",
    environmentVariable: "XAI_API_KEY",
    apiKeyDetail: "Dùng xAI API key; đăng nhập Grok consumer không là API credential.",
    preset: {
      protocol: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.x.ai/v1",
      credentialHeader: "Authorization: Bearer",
    },
  },
  {
    id: "zai",
    displayName: "Z.AI API",
    environmentVariable: "ZAI_API_KEY",
    apiKeyDetail: "Dùng Z.AI API key cho endpoint API của Z.AI.",
    preset: {
      protocol: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.z.ai/api/paas/v4",
      credentialHeader: "Authorization: Bearer",
    },
  },
];

const providerById = new Map(providerDefinitions.map((provider) => [provider.id, provider]));
const safeEnvironmentName = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface ProviderConnectionView {
  id: string;
  category: "ACCOUNT_AGENT" | "AI_PROVIDER";
  provider: string;
  method: string;
  status:
    | "NOT_CONFIGURED"
    | "CONFIGURED"
    | "CONNECTED"
    | "AUTHENTICATION_FAILED"
    | "ENDPOINT_UNREACHABLE"
    | "PROTOCOL_INCOMPATIBLE"
    | "OAUTH_CONFIGURATION_REQUIRED";
  capability: string;
  credentialReference?: string;
  connectionReference?: string;
  protocol?: EndpointProtocol;
  baseUrl?: string;
  defaultModel?: string;
  detail: string;
  credentialSources: Array<{
    id: ProviderCredentialSource;
    label: string;
    available: boolean;
    detail: string;
  }>;
  authentication?: string;
  authCapabilities?: {
    supportsNativeLogin: boolean;
    supportsOAuth: boolean;
    supportsDeviceFlow: boolean;
    requiresCli: boolean;
    cliAvailable: boolean;
    loginMethod: "OAUTH_PKCE";
    installUrl: string;
  };
}

interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Intentionally process-local: without a durable secret manager MAF must never pretend the key
 * survives a restart. Values are encrypted at rest in the process heap and are never serialised.
 */
export class LocalEncryptedCredentialVault {
  private readonly key: Buffer;
  private readonly records = new Map<string, EncryptedSecret>();
  private readonly autoProvisioned: boolean;

  constructor(masterKey = process.env.MAF_LOCAL_VAULT_MASTER_KEY) {
    const configuredKey = masterKey?.trim();
    this.autoProvisioned = !configuredKey;
    this.key = configuredKey
      ? createHash("sha256").update(configuredKey).digest()
      : randomBytes(32);
  }

  available(): boolean {
    return true;
  }

  storageDetail(): string {
    return this.autoProvisioned
      ? "Vault cục bộ được tạo tự động cho phiên server này; credential biến mất khi server khởi động lại."
      : "AES-256-GCM, chỉ tồn tại trong tiến trình hiện tại.";
  }

  put(secret: string): string {
    if (!secret.trim() || secret.length > 8_000) throw new Error("Credential value is invalid");
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    this.records.set(id, { ciphertext, iv, tag: cipher.getAuthTag() });
    return `credential://local-vault/${id}`;
  }

  get(reference: string): string | undefined {
    if (!reference.startsWith("credential://local-vault/")) return undefined;
    const record = this.records.get(reference.slice("credential://local-vault/".length));
    if (!record) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, record.iv);
    decipher.setAuthTag(record.tag);
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
  }

  remove(reference: string): void {
    if (!reference.startsWith("credential://local-vault/")) return;
    this.records.delete(reference.slice("credential://local-vault/".length));
  }
}

interface OAuthAttempt {
  ownerId: string;
  verifier: string;
  expiresAt: number;
}

interface GoogleTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class GoogleGeminiOAuth {
  private readonly attempts = new Map<string, OAuthAttempt>();

  constructor(
    private readonly vault: LocalEncryptedCredentialVault,
    private readonly clientId = process.env.GOOGLE_OAUTH_CLIENT_ID,
    private readonly clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    private readonly publicBaseUrl = process.env.MAF_PUBLIC_BASE_URL ?? "http://127.0.0.1:4310",
  ) {}

  available(): boolean {
    return Boolean(this.clientId && this.vault.available());
  }

  start(ownerId: string): string {
    if (!this.clientId) throw new Error("Google OAuth requires GOOGLE_OAUTH_CLIENT_ID");
    if (!this.vault.available())
      throw new Error("Google OAuth requires a local encrypted vault to protect tokens");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.attempts.set(state, { ownerId, verifier, expiresAt: Date.now() + 10 * 60_000 });
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.publicBaseUrl}/api/v1/connections/oauth/google/callback`,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/generative-language.retriever",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async complete(
    state: string,
    code: string,
  ): Promise<{ ownerId: string; credentialReference: string }> {
    const attempt = this.attempts.get(state);
    this.attempts.delete(state);
    if (!attempt || attempt.expiresAt < Date.now())
      throw new Error("OAuth state is invalid or expired");
    if (!this.clientId) throw new Error("Google OAuth is not configured");
    const values = new URLSearchParams({
      code,
      client_id: this.clientId,
      redirect_uri: `${this.publicBaseUrl}/api/v1/connections/oauth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: attempt.verifier,
    });
    if (this.clientSecret) values.set("client_secret", this.clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: values,
    });
    if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
    const token = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    return {
      ownerId: attempt.ownerId,
      credentialReference: this.vault.put(JSON.stringify(this.tokenSet(token))),
    };
  }

  async refresh(reference: string): Promise<string> {
    const stored = this.vault.get(reference);
    if (!stored) throw new Error("OAuth credential is unavailable");
    const current = parseGoogleTokenSet(stored);
    if (current.expiresAt > Date.now() + 60_000) return reference;
    if (!current.refreshToken || !this.clientId) throw new Error("OAuth token cannot be refreshed");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.clientId,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error("OAuth token refresh failed");
    const token = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    const next = this.vault.put(
      JSON.stringify({
        ...this.tokenSet(token),
        refreshToken: token.refresh_token ?? current.refreshToken,
      }),
    );
    this.vault.remove(reference);
    return next;
  }

  private tokenSet(token: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  }): GoogleTokenSet {
    if (typeof token.access_token !== "string")
      throw new Error("Google token exchange returned no access token");
    return {
      accessToken: token.access_token,
      ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in ?? 3_600)) * 1_000,
    };
  }
}

export class ProviderConnectionRegistry {
  private readonly bindings = new CredentialBindingStore();
  private readonly configured = new Map<
    string,
    {
      source: ProviderCredentialSource;
      reference: string;
      environmentVariable?: string;
      defaultModel?: string;
    }
  >();
  private readonly custom = new Map<string, CustomConnection>();
  private readonly health = new Map<string, ConnectionHealth>();
  private readonly googleAccounts = new Map<string, string>();

  constructor(
    private readonly vault = new LocalEncryptedCredentialVault(),
    private readonly googleOAuth = new GoogleGeminiOAuth(vault),
  ) {}

  list(ownerId: string): ProviderConnectionView[] {
    return [
      ...providerDefinitions.map<ProviderConnectionView>((definition) => {
        const configured = this.configured.get(this.key(ownerId, definition.id));
        const status = configured ? "CONFIGURED" : "NOT_CONFIGURED";
        return {
          id: `${definition.id}-api`,
          category: "AI_PROVIDER",
          provider: definition.displayName,
          method: configured?.source ?? "API_KEY",
          status,
          capability: "Credential cho API provider (executor API cần được cấu hình riêng)",
          ...(configured ? { credentialReference: configured.reference } : {}),
          ...(configured?.defaultModel ? { defaultModel: configured.defaultModel } : {}),
          detail: configured
            ? configured.source === "ENVIRONMENT"
              ? `Đã liên kết biến môi trường ${configured.environmentVariable}; MAF không đọc lại giá trị qua API.`
              : configured.source === "OAUTH_PKCE"
                ? "Đã lưu token OAuth trong vault mã hóa cục bộ, chỉ tồn tại cho đến khi server khởi động lại."
                : "Đã lưu API key trong vault mã hóa cục bộ, chỉ tồn tại cho đến khi server khởi động lại."
            : definition.apiKeyDetail,
          credentialSources: [
            {
              id: "ENVIRONMENT",
              label: "Biến môi trường",
              available: true,
              detail: `Khuyến nghị: ${definition.environmentVariable}. Key không đi qua trình duyệt hay database MAF.`,
            },
            {
              id: "LOCAL_ENCRYPTED_VAULT",
              label: "Vault mã hóa cục bộ",
              available: this.vault.available(),
              detail: this.vault.available()
                ? this.vault.storageDetail()
                : "Vault cục bộ không sẵn sàng.",
            },
          ],
        };
      }),
      ...[...this.custom.values()]
        .filter((connection) => connection.ownerId === ownerId)
        .map((connection) => this.customView(connection)),
    ];
  }

  configureEnvironment(
    ownerId: string,
    providerId: string,
    environmentVariable: string,
    defaultModel?: string,
  ): ProviderConnectionView {
    const definition = this.definition(providerId);
    if (!safeEnvironmentName.test(environmentVariable))
      throw new Error("Environment variable name is invalid");
    const reference = `credential://environment/${environmentVariable.toLowerCase()}`;
    this.bind(ownerId, definition.id, "ENVIRONMENT", reference, {
      environmentVariable,
      ...(defaultModel ? { defaultModel: validateOptionalModel(defaultModel) } : {}),
    });
    return this.connection(ownerId, definition.id);
  }

  configureVault(
    ownerId: string,
    providerId: string,
    apiKey: string,
    defaultModel?: string,
  ): ProviderConnectionView {
    const definition = this.definition(providerId);
    const reference = this.vault.put(apiKey);
    this.bind(ownerId, definition.id, "LOCAL_ENCRYPTED_VAULT", reference, {
      ...(defaultModel ? { defaultModel: validateOptionalModel(defaultModel) } : {}),
    });
    return this.connection(ownerId, definition.id);
  }

  configureCustom(ownerId: string, input: CustomEndpointInput): ProviderConnectionView {
    const normalized = normalizeCustomEndpoint(input);
    const id = `custom-${randomUUID()}`;
    const credentialReference = this.vault.put(
      JSON.stringify({
        apiKey: normalized.apiKey,
        secretHeaders: normalized.headers
          .filter((header) => header.classification === "SECRET")
          .map(({ name, value }) => ({ name, value })),
      }),
    );
    const connection: CustomConnection = {
      id,
      ownerId,
      name: normalized.name,
      protocol: normalized.protocol,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      timeoutMs: normalized.timeoutMs,
      credentialReference,
      publicHeaders: normalized.headers
        .filter((header) => header.classification === "PUBLIC")
        .map(({ name, value }) => ({ name, value })),
    };
    this.bind(ownerId, id, "LOCAL_ENCRYPTED_VAULT", credentialReference, {
      connection: `connection://custom/${id}`,
      protocol: connection.protocol,
    });
    this.custom.set(this.customKey(ownerId, id), connection);
    this.health.set(this.customKey(ownerId, id), { status: "CONFIGURED" });
    return this.customView(connection);
  }

  disconnect(ownerId: string, connectionId: string): void {
    if (connectionId === "gemini-account") {
      const reference = this.googleAccounts.get(ownerId);
      if (reference) this.vault.remove(reference);
      this.googleAccounts.delete(ownerId);
      return;
    }
    const custom = this.custom.get(this.customKey(ownerId, connectionId));
    if (custom) {
      this.vault.remove(custom.credentialReference);
      this.custom.delete(this.customKey(ownerId, connectionId));
      this.health.delete(this.customKey(ownerId, connectionId));
      return;
    }
    const providerId = connectionId.replace(/-api$/u, "");
    const configured = this.configured.get(this.key(ownerId, providerId as ApiProviderId));
    if (!configured) throw new Error("Connection is not configured");
    if (configured.source !== "ENVIRONMENT") this.vault.remove(configured.reference);
    this.configured.delete(this.key(ownerId, providerId as ApiProviderId));
  }

  beginGoogleAccountOAuth(ownerId: string): string {
    return this.googleOAuth.start(ownerId);
  }

  async completeGoogleOAuth(state: string, code: string): Promise<void> {
    const completed = await this.googleOAuth.complete(state, code);
    const previous = this.googleAccounts.get(completed.ownerId);
    if (previous) this.vault.remove(previous);
    this.googleAccounts.set(completed.ownerId, completed.credentialReference);
  }

  account(ownerId: string): ProviderConnectionView {
    const reference = this.googleAccounts.get(ownerId);
    const available = this.googleOAuth.available();
    return {
      id: "gemini-account",
      category: "ACCOUNT_AGENT",
      provider: "Gemini",
      method: "OAUTH_PKCE",
      status: reference
        ? "CONNECTED"
        : available
          ? "NOT_CONFIGURED"
          : "OAUTH_CONFIGURATION_REQUIRED",
      authentication: "Tài khoản Google",
      capability:
        "Google OAuth cho Gemini là kết nối account riêng; Gemini API key và quota API vẫn tách biệt.",
      connectionReference: "connection://gemini/google-account",
      ...(reference ? { credentialReference: reference } : {}),
      detail: reference
        ? "Google OAuth được bảo vệ trong vault local. MAF chỉ giữ reference, không trả token về trình duyệt."
        : available
          ? "Đăng nhập Google mở OAuth PKCE trong trình duyệt."
          : "Luồng đăng nhập Google chưa được triển khai cho server này vì thiếu OAuth client hợp lệ hoặc vault. Đây là cấu hình server, không phải lỗi đăng nhập tài khoản của bạn.",
      credentialSources: [],
      authCapabilities: {
        supportsNativeLogin: false,
        supportsOAuth: true,
        supportsDeviceFlow: false,
        requiresCli: false,
        cliAvailable: available,
        loginMethod: "OAUTH_PKCE",
        installUrl: "https://ai.google.dev/gemini-api/docs/oauth",
      },
    };
  }

  async testGoogleAccount(ownerId: string): Promise<{
    status: string;
    detail: string;
    lastCheckedAt: string;
  }> {
    const reference = this.googleAccounts.get(ownerId);
    const lastCheckedAt = new Date().toISOString();
    if (!reference)
      return {
        status: "NOT_CONFIGURED",
        detail: "Chưa đăng nhập tài khoản Google.",
        lastCheckedAt,
      };
    try {
      const next = await this.googleOAuth.refresh(reference);
      if (next !== reference) this.googleAccounts.set(ownerId, next);
      return {
        status: "CONNECTED",
        detail: "Google OAuth token còn hiệu lực hoặc đã được refresh trong vault.",
        lastCheckedAt,
      };
    } catch {
      return {
        status: "AUTHENTICATION_REQUIRED",
        detail: "Google OAuth đã hết hạn hoặc không thể refresh. Hãy đăng nhập lại.",
        lastCheckedAt,
      };
    }
  }

  async test(
    ownerId: string,
    providerId: string,
  ): Promise<{ status: string; detail: string; lastCheckedAt: string; models?: string[] }> {
    const custom = this.custom.get(this.customKey(ownerId, providerId));
    if (custom) return this.testCustom(custom);
    const definition = this.definition(providerId);
    const configured = this.configured.get(this.key(ownerId, definition.id));
    const lastCheckedAt = new Date().toISOString();
    if (!configured)
      return {
        status: "NOT_CONFIGURED",
        detail: "Chưa có credential được liên kết cho provider này.",
        lastCheckedAt,
      };
    if (configured.source === "ENVIRONMENT") {
      const present = Boolean(process.env[configured.environmentVariable ?? ""]);
      return {
        status: present ? "CONFIGURED" : "AUTHENTICATION_REQUIRED",
        detail: present
          ? "Đã tìm thấy credential trong biến môi trường. Kiểm tra này không gọi API provider và không phát sinh chi phí."
          : `Không thấy ${configured.environmentVariable}; hãy đặt biến rồi khởi động lại server.`,
        lastCheckedAt,
      };
    }
    return {
      status: this.vault.get(configured.reference) ? "CONFIGURED" : "AUTHENTICATION_REQUIRED",
      detail:
        "Credential được bảo vệ trong vault cục bộ của tiến trình. Kiểm tra này không gọi API provider.",
      lastCheckedAt,
    };
  }

  private bind(
    ownerId: string,
    provider: ApiProviderId | string,
    source: ProviderCredentialSource,
    reference: string,
    metadata: Record<string, string> = {},
  ) {
    const binding: CredentialBinding = {
      id: `provider-${ownerId}-${provider}`,
      ownerId,
      provider,
      strategy: source === "OAUTH_PKCE" ? "MANAGED_OAUTH" : "USER_API_KEY",
      credentialReference: reference,
      scope: ["models.execute"],
      status: "ACTIVE",
      metadata: { source, ...metadata },
    };
    this.bindings.add(binding);
    this.configured.set(this.key(ownerId, provider), {
      source,
      reference,
      ...(metadata.environmentVariable
        ? { environmentVariable: metadata.environmentVariable }
        : {}),
      ...(metadata.defaultModel ? { defaultModel: metadata.defaultModel } : {}),
    });
  }

  private connection(ownerId: string, providerId: ApiProviderId): ProviderConnectionView {
    const found = this.list(ownerId).find((connection) => connection.id === `${providerId}-api`);
    if (!found) throw new Error("Provider connection is unavailable");
    return found;
  }

  private definition(providerId: string): ProviderDefinition {
    const provider = providerById.get(providerId as ApiProviderId);
    if (!provider) throw new Error("Unsupported provider");
    return provider;
  }

  private key(ownerId: string, provider: string): string {
    return `${ownerId}:${provider}`;
  }

  private customKey(ownerId: string, connectionId: string): string {
    return `${ownerId}:${connectionId}`;
  }

  private customView(connection: CustomConnection): ProviderConnectionView {
    const health = this.health.get(this.customKey(connection.ownerId, connection.id));
    return {
      id: connection.id,
      category: "AI_PROVIDER",
      provider: connection.name,
      method: "CUSTOM_ENDPOINT",
      status: health?.status ?? "CONFIGURED",
      capability: "Custom API endpoint; thực thi chỉ qua adapter tương thích đã cấu hình",
      credentialReference: connection.credentialReference,
      connectionReference: `connection://custom/${connection.id}`,
      protocol: connection.protocol,
      baseUrl: publicEndpointLabel(connection.baseUrl),
      defaultModel: connection.model,
      detail: health?.detail ?? "Đã lưu API credential trong vault cục bộ; chưa kiểm tra endpoint.",
      credentialSources: [
        {
          id: "LOCAL_ENCRYPTED_VAULT",
          label: "Vault mã hóa cục bộ",
          available: this.vault.available(),
          detail: this.vault.storageDetail(),
        },
      ],
    };
  }

  private async testCustom(
    connection: CustomConnection,
  ): Promise<{ status: string; detail: string; lastCheckedAt: string; models?: string[] }> {
    const lastCheckedAt = new Date().toISOString();
    const secret = this.vault.get(connection.credentialReference);
    if (!secret) {
      return {
        status: "AUTHENTICATION_FAILED",
        detail: "Credential không còn trong vault.",
        lastCheckedAt,
      };
    }
    const parsed = parseCustomSecret(secret);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...Object.fromEntries(connection.publicHeaders.map(({ name, value }) => [name, value])),
    };
    if (connection.protocol === "OPENAI_COMPATIBLE")
      headers.Authorization = `Bearer ${parsed.apiKey}`;
    else {
      headers["x-api-key"] = parsed.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
    for (const header of parsed.secretHeaders) headers[header.name] = header.value;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), connection.timeoutMs);
      const response = await fetch(new URL("models", `${connection.baseUrl}/`), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 401 || response.status === 403)
        return this.remember(
          connection,
          "AUTHENTICATION_FAILED",
          "Endpoint từ chối xác thực.",
          lastCheckedAt,
        );
      if (response.status >= 300 && response.status < 400)
        return this.remember(
          connection,
          "PROTOCOL_INCOMPATIBLE",
          "Endpoint trả redirect; credential không được chuyển tiếp.",
          lastCheckedAt,
        );
      if (!response.ok)
        return this.remember(
          connection,
          "ENDPOINT_UNREACHABLE",
          `Endpoint trả HTTP ${response.status}.`,
          lastCheckedAt,
        );
      const body = (await response.json()) as { data?: unknown; models?: unknown };
      const candidates = Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : undefined;
      if (!candidates)
        return this.remember(
          connection,
          "PROTOCOL_INCOMPATIBLE",
          "Endpoint không trả danh sách model tương thích.",
          lastCheckedAt,
        );
      const models = candidates
        .map((item) =>
          typeof item === "string"
            ? item
            : typeof item === "object" && item && "id" in item
              ? String(item.id)
              : "",
        )
        .filter(Boolean)
        .slice(0, 50);
      return this.remember(
        connection,
        "CONNECTED",
        "Xác thực thành công qua model-list endpoint; không chạy generation.",
        lastCheckedAt,
        models,
      );
    } catch (error) {
      const detail =
        error instanceof Error && error.name === "AbortError"
          ? "Endpoint hết thời gian chờ."
          : "Không thể kết nối endpoint.";
      return this.remember(connection, "ENDPOINT_UNREACHABLE", detail, lastCheckedAt);
    }
  }

  private remember(
    connection: CustomConnection,
    status: ConnectionHealth["status"],
    detail: string,
    lastCheckedAt: string,
    models?: string[],
  ): { status: string; detail: string; lastCheckedAt: string; models?: string[] } {
    this.health.set(this.customKey(connection.ownerId, connection.id), { status, detail });
    return { status, detail, lastCheckedAt, ...(models ? { models } : {}) };
  }
}

interface CustomConnection {
  id: string;
  ownerId: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  credentialReference: string;
  publicHeaders: Array<{ name: string; value: string }>;
}

interface ConnectionHealth {
  status: ProviderConnectionView["status"];
  detail?: string;
}

const unsafeHeaderNames = new Set([
  "authorization",
  "host",
  "content-length",
  "cookie",
  "proxy-authorization",
]);
const headerNamePattern = /^[A-Za-z0-9-]{1,100}$/u;

const validateOptionalModel = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error("Default model is invalid");
  return normalized;
};

const normalizeCustomEndpoint = (input: CustomEndpointInput): Required<CustomEndpointInput> => {
  if (!input.name.trim() || input.name.length > 120)
    throw new Error("Custom provider name is invalid");
  if (!input.model.trim() || input.model.length > 200) throw new Error("Default model is invalid");
  if (!input.apiKey.trim() || input.apiKey.length > 8_000) throw new Error("API key is invalid");
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new Error("Endpoint URL is invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Custom endpoint must use HTTPS (HTTP is allowed only for loopback)");
  const headers = input.headers ?? [];
  if (headers.length > 20) throw new Error("Too many custom headers");
  for (const header of headers) {
    if (!headerNamePattern.test(header.name) || unsafeHeaderNames.has(header.name.toLowerCase()))
      throw new Error("Custom header name is not allowed");
    if (!header.value || header.value.length > 2_000)
      throw new Error("Custom header value is invalid");
  }
  return {
    name: input.name.trim(),
    protocol: input.protocol,
    baseUrl: url.toString().replace(/\/$/u, ""),
    apiKey: input.apiKey,
    model: input.model.trim(),
    headers,
    timeoutMs: Math.max(1_000, Math.min(input.timeoutMs ?? 10_000, 30_000)),
  };
};

const parseCustomSecret = (
  value: string,
): { apiKey: string; secretHeaders: Array<{ name: string; value: string }> } => {
  const parsed = JSON.parse(value) as { apiKey?: unknown; secretHeaders?: unknown };
  if (typeof parsed.apiKey !== "string" || !Array.isArray(parsed.secretHeaders))
    throw new Error("Custom credential is invalid");
  return {
    apiKey: parsed.apiKey,
    secretHeaders: parsed.secretHeaders.filter(
      (header): header is { name: string; value: string } =>
        typeof header === "object" &&
        header !== null &&
        "name" in header &&
        "value" in header &&
        typeof header.name === "string" &&
        typeof header.value === "string",
    ),
  };
};

const parseGoogleTokenSet = (value: string): GoogleTokenSet => {
  const parsed = JSON.parse(value) as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
  if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number")
    throw new Error("OAuth credential is invalid");
  return {
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
    expiresAt: parsed.expiresAt,
  };
};

const publicEndpointLabel = (value: string): string => {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
};
