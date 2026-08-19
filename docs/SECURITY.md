# Security model

## Secret boundary

- Application state stores `credential://` references, never raw provider keys.
- `CredentialBindingStore` rejects non-reference values.
- `EnvironmentCredentialResolver` resolves a reference only at the gateway edge.
- `AgentVaultBroker` supplies a broker URL and dummy reference credential to a sandbox. It does not
  inject the real upstream credential.
- Recursive redaction removes secret-shaped fields and values before events, artifacts, and telemetry
  are persisted or exported.
- Agent initial context contains credential references only.
- `.env.example` contains placeholders and `.env` is ignored.

The local fixture and mock OAuth paths are labeled `MOCK_VERIFIED`. They do not imply a production
provider test.

Each agent adapter reports a credential boundary capability. Native CLI, ACP, and Claude Code are
`REFERENCE_ONLY`: they receive an allowlisted process environment and credential references, but no
managed provider secret. Agent Vault is `PROXY_MEDIATED`. These labels do not claim OS or network
isolation. The integration probe verifies that a canary secret is absent from the agent artifact,
events, and telemetry while the capability label remains visible.

## Sandbox boundary

The default sandbox is a detached Git worktree under a configured root. ACP file callbacks resolve
absolute paths and reject paths outside that workspace. Verification commands run only within the
sandbox and have a bounded timeout. Production deployments should add OS/container-level resource
and network policy through `DockerSandbox` or a future remote provider.

## Authentication boundaries

User login, third-party OAuth connections, model credentials, and product-issued API keys are
separate concerns. Better Auth config accepts resolved user-auth secrets only when constructing its
runtime. Nango owns external provider token lifecycle. The application stores only a Nango
connection reference. Platform API keys are hashed with SHA-256 and compared using constant-time
comparison in the V0 adapter.

## Permission policy

The ACP adapter defaults permission requests to deny. `ALLOW_ONCE` must be configured explicitly and
selects only an advertised `allow_once` option. This is intentionally separate from agent capability
discovery.

## Remaining production security work

The V0 fixture demonstrates the boundary but does not claim hardened multi-tenant isolation. Before
an internet-facing deployment, add database row-level authorization, rate limiting, CSRF policy for
auth routes, network egress allowlists, encrypted durable credential stores, audit-log export, and
container/remote sandbox resource limits.
