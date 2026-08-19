# Upstream register

All repositories were resolved through official project pages or verified GitHub organizations,
shallow-cloned under a temporary workspace, and inspected on 2026-08-19. No upstream source is
vendored into this repository.

| Project | Canonical repository | License | Audited revision/version | Purpose | Integration and updates |
| --- | --- | --- | --- | --- | --- |
| Agent Client Protocol TypeScript SDK | `agentclientprotocol/typescript-sdk` | Apache-2.0 | `7585334c5b738868583d561bdfc97caf77a3f3ba`; npm `1.3.0` | First-class interoperable agent transport | Pinned package dependency behind `AgentAdapter`; update after ACP conformance tests |
| codebase-memory-mcp | `DeusData/codebase-memory-mcp` | MIT | `46ae198fc11cda80e817acbc5f5908d7c2de7032` | Optional structural project graph | MCP/service adapter; deterministic local index remains fallback |
| Aider | `Aider-AI/aider` | Apache-2.0 | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Repository-map algorithm reference | Reference-only; no copied files; compact map is independently implemented |
| ast-grep | `ast-grep/ast-grep` | MIT | `0eb08389b6c4c5f3e19f90efbcb726fc413ca63d`; npm `0.45.1` | Structural search | Pinned N-API package behind repository-index abstraction |
| Bifrost | `maximhq/bifrost` | Apache-2.0 | `1eaa6840b43571ecec892d6b8cfb78d8bb7c34cb` | Multi-provider LLM gateway | OpenAI-compatible HTTP service adapter; no server code embedded |
| Better Auth | `better-auth/better-auth` | MIT | `64da15b0b1ca078d80f115ee0a5bd9ad4ca4d64e`; npm `1.7.1` | User authentication and OAuth configuration | Pinned package behind `UserAuthProvider`; mock local session is separately labeled |
| Nango | `NangoHQ/nango` | Elastic-2.0 | `7d771c5399102457ba774b943e5d21e1c9aeb4b0` | External-service OAuth lifecycle | API client boundary only; never duplicate provider refresh tokens |
| Infisical Agent Vault | `Infisical/agent-vault` | MIT core; separate `ee/` license | `10743832e3dd362afd30c6e9b26b1732ed0d2766` | Broker provider secrets outside agent sandboxes | HTTP proxy/broker adapter; no enterprise code embedded |
| Unkey | `unkeyed/unkey` | AGPL-3.0 server; package-specific exceptions | `1dfa8b32df11e54655c85245e4a5a95abe21114b` | Future product-issued API keys | Port and schema only in V0; future deployment must receive a license review |
| Langfuse | `langfuse/langfuse` | MIT core; separate enterprise directories | `e68e201a66ac67eaeb2a6dd8f1d36295c092913f` | AI call tracing and cost metadata | Optional HTTP/SDK exporter behind domain telemetry |
| OpenTelemetry JS | `open-telemetry/opentelemetry-js` | Apache-2.0 | `8f103777b707029e9bb18b2755531771de1b80f5`; API npm `1.9.1` | Vendor-neutral traces and metrics | Stable API package; exporters are runtime configuration |
| Fluent UI | `microsoft/fluentui` | MIT; separate font/icon asset terms | `42f76ebac7435ab290cb3281ad065e939e51e1ee`; React npm `9.74.6` | Accessible operations dashboard | Pinned React v9 package; no licensed fonts or external icon assets copied |

Update procedure: fetch the canonical repository, inspect README/license/changelog at the proposed
revision, update the pinned dependency or service image separately, then run `npm run validate`.
