import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { GuidedContextBuilder } from "../application/context-builder";
import { MissionRegistry } from "../application/mission-registry";
import { RunService } from "../application/run-service";
import { EvidenceRuntimeSignalCollector } from "../application/runtime-signal-collector";
import type { RunStore } from "../domain/ports";
import {
  BetterAuthConfigAdapter,
  InMemoryPlatformApiKeys,
  LocalDevelopmentAuth,
  MockExternalConnections,
} from "../infrastructure/credentials";
import { LocalWorktreeSandbox, type SandboxRetention } from "../infrastructure/local-worktree";
import { ClaudeCodeAdapter } from "../infrastructure/claude-code-adapter";
import { InMemoryRunStore } from "../infrastructure/memory-store";
import { NativeCliAdapter } from "../infrastructure/native-cli-adapter";
import { PostgresRunStore } from "../infrastructure/postgres/store";
import {
  InMemoryProjectBrain,
  LocalRepositoryIndex,
  OptionalCodebaseMemoryIndex,
} from "../infrastructure/project-brain";
import { DomainTelemetryRecorder, PostgresTelemetrySink } from "../infrastructure/telemetry";
import { CommandVerifier } from "../infrastructure/verifier";

const createRunSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  repositoryPath: z.string().min(1),
  revision: z.string().min(1).optional(),
  mode: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]).optional(),
  verification: z
    .object({
      command: z.string().max(4_000).optional(),
      expectedFile: z.string().max(1_000).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    })
    .optional(),
  signals: z
    .object({
      dependencyExpansion: z.number().nonnegative().optional(),
      touchedModules: z.number().nonnegative().optional(),
      rootCauseUncertainty: z.number().min(0).max(1).optional(),
      repeatedVerifierFailures: z.number().nonnegative().optional(),
      contextExpansion: z.number().nonnegative().optional(),
      crossModuleEdges: z.number().nonnegative().optional(),
      scopeStabilized: z.boolean().optional(),
      mechanicalRemainingWork: z.boolean().optional(),
      independentWorkstreams: z.number().nonnegative().optional(),
      filesChanged: z.number().nonnegative().optional(),
      newDependenciesDiscovered: z.number().nonnegative().optional(),
      verificationFailureCount: z.number().nonnegative().optional(),
    })
    .optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  credentialReferences: z.array(z.string().startsWith("credential://")).max(20).optional(),
});

const transitionSchema = z.object({
  to: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]),
  reason: z.string().min(1).max(2_000),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const missionNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).optional(),
  dependencyIds: z.array(z.string()),
  state: z.enum(["BLOCKED", "READY", "RUNNING", "DONE", "CANCELLED"]),
  executionMode: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]),
  agent: z.string(),
  model: z.string(),
  budget: z.number().nonnegative(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  verificationState: z.enum([
    "PROPOSED",
    "VERIFYING",
    "VERIFIED",
    "QUARANTINED",
    "FAILED",
    "CANCELLED",
  ]),
});

const fixtureAgentPath = (): { command: string; args: string[] } => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const built = path.resolve(currentDirectory, "../fixtures/native-agent.js");
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  return {
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href,
      path.resolve(process.cwd(), "src/fixtures/native-agent.ts"),
    ],
  };
};

export interface AppRuntime {
  app: FastifyInstance;
  runs: RunService;
  close: () => Promise<void>;
}

export const createApp = async (): Promise<AppRuntime> => {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  let pool: Pool | undefined;
  let store: RunStore;
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    store = new PostgresRunStore(pool);
  } else {
    store = new InMemoryRunStore();
  }
  const brain = new InMemoryProjectBrain();
  const repositoryIndex = new OptionalCodebaseMemoryIndex(new LocalRepositoryIndex());
  const genericTelemetry = new DomainTelemetryRecorder();
  const telemetry = pool ? new PostgresTelemetrySink(pool, genericTelemetry) : genericTelemetry;
  const agentCommand = fixtureAgentPath();
  const agent =
    process.env.MAF_NATIVE_AGENT === "claude"
      ? new ClaudeCodeAdapter({
          command: process.env.CLAUDE_COMMAND ?? "claude",
          ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
          ...(process.env.CLAUDE_MAX_BUDGET_USD
            ? { maxBudgetUsd: Number(process.env.CLAUDE_MAX_BUDGET_USD) }
            : {}),
        })
      : new NativeCliAdapter(agentCommand);
  const sandboxRoot = path.resolve(
    process.env.SANDBOX_ROOT ?? path.join(process.cwd(), ".adaptive-harness", "worktrees"),
  );
  const retention = (process.env.SANDBOX_RETENTION ?? "failed") as SandboxRetention;
  const runs = new RunService({
    store,
    agent,
    sandbox: new LocalWorktreeSandbox(sandboxRoot, retention),
    verifier: new CommandVerifier(),
    repositoryIndex,
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  const auth = new LocalDevelopmentAuth();
  const authConfig = new BetterAuthConfigAdapter();
  const externalConnections = new MockExternalConnections();
  const platformKeys = new InMemoryPlatformApiKeys();
  const missions = new MissionRegistry();

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
    reply.code(statusCode).send({
      error: statusCode === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
      message: normalized.message,
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    store: pool ? "postgres" : "memory",
    repositoryIndex: repositoryIndex.status(),
  }));
  app.post("/api/v1/runs", async (request, reply) => {
    const body = createRunSchema.parse(request.body);
    const run = await runs.create(body);
    return reply.code(202).send(run);
  });
  app.get("/api/v1/runs", async () => runs.listSummaries());
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
    const run = await runs.get(request.params.id);
    return run ? run : reply.code(404).send({ error: "RUN_NOT_FOUND" });
  });
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/artifacts", async (request) =>
    runs.artifacts(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/verifications", async (request) =>
    runs.verifications(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/runtime-signals", async (request) =>
    runs.signalSnapshots(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/mode-explanation", async (request) =>
    runs.modeExplanation(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request) =>
    runs.cancel(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/mode", async (request) => {
    const body = transitionSchema.parse(request.body);
    return runs.transition(request.params.id, body.to, body.reason, body.evidence);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string; follow?: string } }>(
    "/api/v1/runs/:id/events",
    async (request, reply) => {
      const run = await runs.get(request.params.id);
      if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      let cursor = request.query.after;
      const follow = request.query.follow !== "false";
      while (!reply.raw.destroyed) {
        const events = await runs.events(request.params.id, cursor);
        for (const event of events) {
          reply.raw.write(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.id;
        }
        const current = await runs.get(request.params.id);
        if (!follow || !current || ["COMPLETED", "FAILED", "CANCELLED"].includes(current.state))
          break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      reply.raw.end();
    },
  );
  app.get("/api/v1/auth/session", async (request, reply) => {
    const session = await auth.session(request.headers);
    return session ? session : reply.code(401).send({ error: "UNAUTHENTICATED" });
  });
  app.get("/api/v1/auth/config", async () =>
    authConfig.config(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4310"),
  );
  app.post<{ Body: { provider: string; ownerId: string } }>(
    "/api/v1/connections/authorize",
    async (request) => ({
      url: await externalConnections.createAuthorizationUrl(
        request.body.provider,
        request.body.ownerId,
      ),
      verification: "MOCK_VERIFIED",
    }),
  );
  app.post<{ Body: { ownerId: string; scopes: string[] } }>(
    "/api/v1/platform-keys",
    async (request, reply) =>
      reply.code(201).send(await platformKeys.issue(request.body.ownerId, request.body.scopes)),
  );
  app.get("/api/v1/telemetry/cost-per-verified-success", async () => ({
    value: await telemetry.costPerVerifiedSuccess(),
    currency: "USD",
  }));
  app.get("/api/v1/missions", async () => missions.list());
  app.post("/api/v1/missions", async (request, reply) =>
    reply.code(201).send(missions.create(missionNodeSchema.parse(request.body))),
  );
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/split", async (request) => {
    const body = z
      .object({ parentId: z.string(), children: z.array(missionNodeSchema).min(2) })
      .parse(request.body);
    return missions.split(request.params.id, body.parentId, body.children);
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/merge", async (request) => {
    const body = z
      .object({ nodeIds: z.array(z.string()).min(2), merged: missionNodeSchema })
      .parse(request.body);
    return missions.merge(request.params.id, body.nodeIds, body.merged);
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/promote", async (request) => {
    const body = z.object({ nodeId: z.string(), output: z.string() }).parse(request.body);
    return missions.promote(request.params.id, body.nodeId, body.output);
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/collapse", async (request) => {
    const body = z.object({ parentId: z.string() }).parse(request.body);
    return missions.collapse(request.params.id, body.parentId);
  });

  const webRoot = path.resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.get("/*", (_request, reply) => reply.sendFile("index.html"));
  }

  return {
    app,
    runs,
    close: async () => {
      await app.close();
      if (pool) await pool.end();
    },
  };
};
