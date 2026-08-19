import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  CredentialBinding,
  CredentialResolver,
  ExternalConnectionProvider,
  PlatformApiKeyProvider,
  UserAuthProvider,
  UserSession,
} from "../domain/ports";

export class CredentialBindingStore {
  private readonly bindings = new Map<string, CredentialBinding>();

  add(binding: CredentialBinding): void {
    if (!binding.credentialReference.startsWith("credential://")) {
      throw new Error("Credential bindings must store references, never raw credentials");
    }
    this.bindings.set(binding.id, structuredClone(binding));
  }

  list(ownerId: string): CredentialBinding[] {
    return [...this.bindings.values()]
      .filter((binding) => binding.ownerId === ownerId)
      .map((binding) => structuredClone(binding));
  }
}

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly references: Record<string, string>) {}

  async resolve(reference: string, provider: string): Promise<string> {
    if (!reference.startsWith("credential://")) throw new Error("Raw credential input rejected");
    const environmentName = this.references[reference];
    if (!environmentName) throw new Error(`No credential mapping for ${reference}`);
    const secret = process.env[environmentName];
    if (!secret) throw new Error(`Credential for ${provider} is not available`);
    return secret;
  }
}

export const redactSecrets = (value: unknown): unknown => {
  const secretKey = /(api[-_]?key|secret|token|authorization|password|credential)/iu;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKey.test(key) && !key.toLowerCase().endsWith("reference")
          ? "[REDACTED]"
          : redactSecrets(child),
      ]),
    );
  }
  return value;
};

export class LocalDevelopmentAuth implements UserAuthProvider {
  async session(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<UserSession | undefined> {
    const emailHeader = headers["x-dev-user"];
    const email = Array.isArray(emailHeader) ? emailHeader[0] : emailHeader;
    if (!email) return undefined;
    return {
      userId: createHash("sha256").update(email).digest("hex").slice(0, 24),
      email,
      verification: "MOCK_VERIFIED",
    };
  }
}

export interface BetterAuthRuntimeConfig {
  baseURL: string;
  secretReference: string;
  socialProviders: Record<string, { clientIdReference: string; clientSecretReference: string }>;
  organizationReady: boolean;
}

export interface BetterAuthRuntimeSecrets {
  secret: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
}

export class BetterAuthConfigAdapter {
  config(baseURL: string): BetterAuthRuntimeConfig {
    return {
      baseURL,
      secretReference: "credential://platform/better-auth-secret",
      socialProviders: {
        github: {
          clientIdReference: "credential://platform/github-client-id",
          clientSecretReference: "credential://platform/github-client-secret",
        },
        google: {
          clientIdReference: "credential://platform/google-client-id",
          clientSecretReference: "credential://platform/google-client-secret",
        },
      },
      organizationReady: true,
    };
  }

  async createRuntime(baseURL: string, secrets: BetterAuthRuntimeSecrets) {
    if (secrets.secret.length < 32)
      throw new Error("Better Auth secret must contain at least 32 characters");
    const { betterAuth } = await import("better-auth");
    return betterAuth({
      baseURL,
      secret: secrets.secret,
      emailAndPassword: { enabled: true },
      socialProviders: {
        ...(secrets.github ? { github: secrets.github } : {}),
        ...(secrets.google ? { google: secrets.google } : {}),
      },
    });
  }
}

export class MockExternalConnections implements ExternalConnectionProvider {
  private readonly references = new Map<string, string>();

  async createAuthorizationUrl(provider: string, ownerId: string): Promise<string> {
    const reference = `connection://mock/${provider}/${ownerId}`;
    this.references.set(`${provider}:${ownerId}`, reference);
    return `http://127.0.0.1/mock-oauth/callback?provider=${encodeURIComponent(provider)}&owner=${encodeURIComponent(ownerId)}`;
  }

  async getConnectionReference(provider: string, ownerId: string): Promise<string | undefined> {
    return this.references.get(`${provider}:${ownerId}`);
  }
}

export class NangoExternalConnections implements ExternalConnectionProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKeyResolver: () => Promise<string>,
  ) {}

  async createAuthorizationUrl(provider: string, ownerId: string): Promise<string> {
    const key = await this.secretKeyResolver();
    const response = await fetch(`${this.baseUrl}/connect/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ end_user: { id: ownerId }, allowed_integrations: [provider] }),
    });
    if (!response.ok) throw new Error(`Nango session failed with ${response.status}`);
    const body = (await response.json()) as { data?: { token?: string } };
    if (!body.data?.token) throw new Error("Nango did not return a connect token");
    return `${this.baseUrl}/connect?token=${encodeURIComponent(body.data.token)}`;
  }

  async getConnectionReference(provider: string, ownerId: string): Promise<string | undefined> {
    return `connection://nango/${provider}/${ownerId}`;
  }
}

interface ApiKeyRecord {
  id: string;
  ownerId: string;
  hash: Buffer;
  scopes: string[];
  revoked: boolean;
}

export class InMemoryPlatformApiKeys implements PlatformApiKeyProvider {
  private readonly records = new Map<string, ApiKeyRecord>();

  async issue(ownerId: string, scopes: string[]): Promise<{ key: string; id: string }> {
    const id = crypto.randomUUID();
    const key = `ah_${randomBytes(24).toString("base64url")}`;
    this.records.set(id, {
      id,
      ownerId,
      hash: createHash("sha256").update(key).digest(),
      scopes: [...scopes],
      revoked: false,
    });
    return { key, id };
  }

  async verify(key: string, scope: string): Promise<boolean> {
    const candidate = createHash("sha256").update(key).digest();
    return [...this.records.values()].some(
      (record) =>
        !record.revoked &&
        record.scopes.includes(scope) &&
        record.hash.length === candidate.length &&
        timingSafeEqual(record.hash, candidate),
    );
  }

  async revoke(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) record.revoked = true;
  }
}

export class AgentVaultBroker {
  constructor(private readonly proxyUrl: string) {}

  mediatedEnvironment(reference: string): Record<string, string> {
    if (!reference.startsWith("credential://")) throw new Error("Agent Vault expects a reference");
    return {
      HTTPS_PROXY: this.proxyUrl,
      HARNESS_CREDENTIAL_REFERENCE: reference,
      HARNESS_DUMMY_CREDENTIAL: `__${createHash("sha256").update(reference).digest("hex").slice(0, 20)}__`,
    };
  }
}
