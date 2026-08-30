# Security model

## Secret boundary

- Application state stores `credential://` references, never raw provider keys.
- `CredentialBindingStore` rejects non-reference values.
- `EnvironmentCredentialResolver` resolves a reference only at the gateway edge.
- `AgentVaultBroker` supplies a broker URL and dummy reference credential to a sandbox. It does not
  inject the real upstream credential.
- Recursive redaction removes known secret-shaped fields, structured tokens, generic credential
  assignments, and complete PEM private-key blocks before events and telemetry are persisted or
  exported. Reference-shaped fields preserve only validated, secret-free `credential://` locators;
  a field name alone cannot exempt a raw value. Diff artifacts use file-level added-line suppression
  when a file contains credential-shaped content and remove uninspectable binary-patch payloads
  entirely. Gitlinks and rename/copy-only changes remain `NOT_CHECKED` because their destination
  bytes are absent from the patch. Stored task goals, run errors, verifier output, changed-file and
  runtime-signal paths, mode-transition evidence, and recovery-capsule text use the same sanitizer.
  Secret-shaped repository/revision/expected-file locators are rejected before task persistence.
  The composed persistence/API path is regression-tested with adjacent and encrypted private-key
  files, quoted/template passphrases, common config/YAML/Go assignment forms,
  binary/gitlink/rename diffs, verifier output,
  adversarial filenames, and secret-bearing failures; this is a bounded guarantee for known harness
  records, not a claim that arbitrary external process output is impossible.
- Agent initial context contains credential references only.
- `.env.example` contains placeholders and `.env` is ignored.

The local Connections vault automatically creates a cryptographically random process key when
`MAF_LOCAL_VAULT_MASTER_KEY` is absent. It uses AES-256-GCM but keeps ciphertext in process memory
only, clears it on restart, and never adds raw provider keys or OAuth tokens to a run, event,
project record, or API response. It is therefore not a substitute for an encrypted durable secret
manager in a deployed service. Google Gemini OAuth
uses an expiring one-time PKCE state and stores exchange results solely in this vault; provider
availability checks never make billable model requests.

Native account login launches only explicit provider CLI commands without a shell, with a bounded
timeout and cancellation path. MAF does not log native CLI stdout/stderr, scrape browser cookies,
copy session files, or perform provider-global logout when the user chooses Disconnect from MAF.

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
