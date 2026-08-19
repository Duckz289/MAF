# Control API

All routes are versioned under `/api/v1`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/runs` | Create an asynchronous run |
| `GET` | `/runs` | List operational summaries for all runs |
| `GET` | `/runs/:id` | Inspect one run |
| `GET` | `/runs/:id/events` | Stream SSE lifecycle events; `follow=false` returns a snapshot |
| `GET` | `/runs/:id/artifacts` | Inspect captured artifacts |
| `POST` | `/runs/:id/cancel` | Cancel a live run |
| `POST` | `/runs/:id/mode` | Record an explicit evidence-backed mode transition |
| `GET/POST` | `/missions` | List or create mission trees |
| `POST` | `/missions/:id/split` | Split independent workstreams |
| `POST` | `/missions/:id/merge` | Merge verified branches |
| `POST` | `/missions/:id/promote` | Promote verified output |
| `POST` | `/missions/:id/collapse` | Collapse children into a solo-native parent |
| `GET` | `/auth/session` | Inspect the local user session |
| `GET` | `/auth/config` | Inspect reference-only Better Auth configuration |
| `POST` | `/connections/authorize` | Start external OAuth connection flow |
| `POST` | `/platform-keys` | Issue a product API key through the configured provider |
| `GET` | `/telemetry/cost-per-verified-success` | Read the primary optimization metric |

Errors use `{ "error": "CODE", "message": "description" }`. Run creation returns HTTP 202. Event
streams use standard SSE `id`, `event`, and JSON `data` fields.
