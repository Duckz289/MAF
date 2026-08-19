# Authentication and credentials

## User authentication

`BetterAuthConfigAdapter` defines email/password, GitHub OAuth, Google OAuth, session, and
organization-ready configuration. Its `createRuntime` method constructs the real Better Auth
runtime after secrets are resolved at the auth edge. The default local endpoint uses
`LocalDevelopmentAuth` with the `x-dev-user` header and returns `MOCK_VERIFIED`.

Do not expose the development auth adapter outside a trusted local environment.

## External integrations

`ExternalConnectionProvider` separates connection lifecycle from application state.
`NangoExternalConnections` creates connect sessions using Nango and returns
`connection://nango/...` references. The default local callback is a mock fixture and is labeled
`MOCK_VERIFIED`. Access and refresh tokens are not duplicated in the harness database.

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

## Product API keys

`PlatformApiKeyProvider` supports issue, verify, and revoke. The local adapter stores only hashes.
The PostgreSQL schema is ready for a durable implementation. Unkey remains a future service adapter
because no public API infrastructure is required for this V0 and its server license requires review.

## Verification labels

- `MOCK_VERIFIED`: local fixture flow succeeded without a real provider.
- `REAL_PROVIDER_VERIFIED`: reserved for successful provider callback and token-lifecycle testing.

This repository currently claims only `MOCK_VERIFIED` for OAuth.
