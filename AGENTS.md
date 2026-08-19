# Agent guide

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and the active plan in
[`docs/exec-plans/active`](docs/exec-plans/active). Core domain code must not import Fastify,
PostgreSQL, Fluent UI, or upstream service clients. Preserve verified-only handoffs and emit a
reason plus evidence for every execution-mode transition.

Validation: `npm run validate`.
