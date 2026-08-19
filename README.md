# Adaptive Agent Harness

A local-first control plane that wraps native coding agents without replacing their planning,
search, or context loops. It provides adaptive execution policy, isolated Git worktrees,
verification, structured repository knowledge, credential references, telemetry, and an operations
dashboard.

## Quick start

```powershell
npm install
npm run build
npm run start
```

Open `http://127.0.0.1:4310`. The default store is in-memory. For durable PostgreSQL state:

```powershell
docker compose up -d postgres
$env:DATABASE_URL = 'postgresql://harness:harness@127.0.0.1:54329/harness'
npm run migrate
npm run start
```

Run the complete local gate with `npm run validate`.
