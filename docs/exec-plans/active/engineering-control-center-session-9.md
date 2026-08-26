# Session 9 — Engineering Control Center foundations

Status: IMPLEMENTED (read models, bounded APIs, navigation shell, Mission Control / Project Map /
Trust / Context inspection foundations).

Starting tree at implementation time:

- Branch: `adaptive-harness/runtime-signals-v0.1`
- Git HEAD: `9ff934e53424501098c5dd4da01cfabe987e7d67`
- Working tree: DIRTY (Sessions 2–8.5 overlay plus this session). No post-audit clean commit was
  present; historical `9ff934e` remained HEAD. Parent: `42928cf`.

## Scope delivered

- Canonical Control Center read models in `src/domain/control-center.ts`
- Minimum PM seam in `src/domain/work.ts` (built-in registry; no Plane types)
- `ControlCenterService` assembler with bounded pages
- HTTP routes under `/api/v1/control-center/*`
- Navigation shell presenting MAF as Engineering Control Center
- Mission Control (`SIMPLE` default), Project Map tab, Trust/Context inspect, Evolution inspect,
  optional provider status, Work items

## Explicitly not done

- Full redesign of every existing Vietnamese screen
- Deep Plane / Linear / Jira / GitHub Issues integration
- Understand Anything runtime
- Production Execution Intelligence routing
- Optimizers or one-click policy promotion
- Generative UI (command-policy seam exists and is tested)
- Store-level event pagination (HTTP responses are bounded after load)

## Engine gaps reported, not patched

- `ProjectBrain.list` returns only ACTIVE same-revision rows. Stale/conflicted bodies are withheld
  locators from `resolveCurrent`, not a new brain query.
- `Run.cost` numeric zeros remain the legacy unknown convention; the read model maps that to
  `UNKNOWN` and never displays `$0`.
