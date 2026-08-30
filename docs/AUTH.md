# Authentication and credentials

## User authentication

`BetterAuthConfigAdapter` defines email/password, GitHub OAuth, Google OAuth, session, and
organization-ready configuration. Its `createRuntime` method constructs the real Better Auth
runtime after secrets are resolved at the auth edge. The default local endpoint uses
`LocalDevelopmentAuth` with the `x-dev-user` header and returns `MOCK_VERIFIED`.

Do not expose the development auth adapter outside a trusted local environment.

## External integrations

`ExternalConnectionProvider` remains an adapter boundary for third-party product integrations.
`NangoExternalConnections` creates connect sessions using Nango and returns
`connection://nango/...` references when a Nango deployment is configured. The reference server
does not expose a mock OAuth endpoint as a real integration.

## Model and agent credentials

`CredentialBinding` contains owner, provider, auth strategy, reference, scope, status, and metadata.
Supported strategies are:

- `NATIVE_OAUTH`
- `MANAGED_OAUTH`
- `USER_API_KEY`
- `PLATFORM_MANAGED_KEY`
- `GATEWAY_MANAGED`

Native OAuth sessions may remain native. Bifrost resolves a reference immediately before the
outbound request. Agent Vault can mediate with a proxy and dummy credential.

The local Connections registry separates account/native connections from OpenAI, Anthropic, Gemini,
xAI, and Z.AI API-key bindings. The normal UI accepts an API key and optional default model; an
environment-variable binding remains an infrastructure option.
An environment-variable binding is preferred and stores only a `credential://environment/...`
reference. `LocalEncryptedCredentialVault` creates a cryptographically random AES-256-GCM key when
no `MAF_LOCAL_VAULT_MASTER_KEY` is configured; ciphertext is held only in the current process and
is deliberately discarded on restart. It is a local-development convenience, not a durable or
multi-tenant secret manager.

Gemini API OAuth has a separate real Google account authorization-code + PKCE flow once
`GOOGLE_OAUTH_CLIENT_ID` is configured. It uses the registered callback
`/api/v1/connections/oauth/google/callback`, checks one-time expiring state, exchanges the code at
Google, records token expiry, refreshes with the returned refresh token when needed, and retains
all returned tokens only in that process-local vault. Codex and Claude Code account cards start the
official native CLI login commands (`codex login` and `claude auth login`) with bounded process
lifetime, cancellation, and status polling. Their CLI output is never persisted or returned. Other
cards intentionally do not offer consumer-account OAuth: ChatGPT/Grok sessions are not API
credentials.

Custom endpoints are first-class connections, not provider-name aliases. They declare either
`OPENAI_COMPATIBLE` or `ANTHROPIC_COMPATIBLE`, a default model, and a sanitized HTTPS base URL.
The model-list health check uses `redirect: "manual"`, so a redirect never forwards the API key or
secret headers to another host. HTTP is limited to loopback endpoints for local development. Header
names that could override the credential/routing boundary (`Authorization`, `Host`, `Cookie`, and
related system headers) are rejected. Public headers remain metadata; API key and headers marked
secret are stored together in the local vault and never returned by connection APIs.

## Product API keys

`PlatformApiKeyProvider` supports issue, verify, and revoke. The local adapter stores only hashes.
The PostgreSQL schema is ready for a durable implementation. Unkey remains a future service adapter
because no public API infrastructure is required for this V0 and its server license requires review.

## Verification labels

- `MOCK_VERIFIED`: local fixture flow succeeded without a real provider.
- `REAL_PROVIDER_VERIFIED`: reserved for successful provider callback and token-lifecycle testing.

OAuth completion means only that the token exchange succeeded; it is not model-execution or
production-verification evidence. The connection test deliberately checks local credential
availability without issuing a billable provider request.
