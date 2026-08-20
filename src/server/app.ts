import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { GuidedContextBuilder } from "../application/context-builder";
import { MissionRegistry } from "../application/mission-registry";
import { InMemoryProjectRegistry } from "../application/project-registry";
import { RunService } from "../application/run-service";
import { EvidenceRuntimeSignalCollector } from "../application/runtime-signal-collector";
import type { RunStore } from "../domain/ports";
import {
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
import { CommandPerformanceVerifier } from "../infrastructure/performance-verifier";
import { CommandResilienceVerifier } from "../infrastructure/resilience-verifier";
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
  performance: z
    .object({
      command: z.string().min(1).max(4_000),
      metric: z.string().min(1).max(120),
      unit: z.string().min(1).max(40).optional(),
      maxRegressionPercent: z.number().nonnegative().max(10_000),
      lowerIsBetter: z.boolean().optional(),
      samples: z.number().int().min(1).max(10).optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    })
    .optional(),
  resilience: z
    .object({
      command: z.string().min(1).max(4_000),
      scenarios: z
        .array(
          z.enum([
            "HIGH_LATENCY",
            "TIMEOUT",
            "CONNECTION_RESET",
            "DUPLICATE_REQUEST",
            "OUT_OF_ORDER_RESPONSE",
            "MALFORMED_UPSTREAM_RESPONSE",
            "RATE_LIMITING",
          ]),
        )
        .max(7)
        .optional(),
      composeFile: z.string().min(1).max(1_000).optional(),
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
  budget: z
    .object({
      mode: z.enum(["ADVISORY", "HARD"]),
      limitUsd: z.number().nonnegative(),
    })
    .optional(),
  qualityPreference: z.enum(["FAST", "BALANCED", "HIGH", "CRITICAL"]).optional(),
});

const transitionSchema = z.object({
  to: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]),
  reason: z.string().min(1).max(2_000),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const resumeSchema = z.object({
  credentialReferences: z.array(z.string().startsWith("credential://")).max(20).optional(),
});

const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryPath: z.string().trim().min(1).max(4_000),
  revision: z.string().trim().min(1).max(500).optional(),
  preferences: z
    .object({
      providerPreference: z.string().max(120).optional(),
      qualityPreference: z.enum(["FAST", "BALANCED", "HIGH", "CRITICAL"]).optional(),
      budgetPreference: z.enum(["AUTO", "CUSTOM"]).optional(),
    })
    .optional(),
});

const platformKeySchema = z.object({
  ownerId: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1).max(120)).min(1).max(20),
});

const claudeConnectionStatus = (): {
  status: "UNKNOWN" | "UNAVAILABLE";
  lastCheckedAt: string;
  detail: string;
} => {
  const checkedAt = new Date().toISOString();
  const result = spawnSync(process.env.CLAUDE_COMMAND ?? "claude", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return {
      status: "UNAVAILABLE",
      lastCheckedAt: checkedAt,
      detail: "Không thể khởi chạy Claude Code. Hãy cài đặt rồi đăng nhập qua Claude CLI.",
    };
  }
  return {
    status: "UNKNOWN",
    lastCheckedAt: checkedAt,
    detail: "Claude Code đã được cài. Phiên đăng nhập native do Claude Code sở hữu và xác minh.",
  };
};

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
      : new NativeCliAdapter({
          ...agentCommand,
          // The bundled fixture agent implements the live policy-update protocol.
          capabilities: { livePolicyUpdate: true },
        });
  const sandboxRoot = path.resolve(
    process.env.SANDBOX_ROOT ?? path.join(process.cwd(), ".adaptive-harness", "worktrees"),
  );
  const retention = (process.env.SANDBOX_RETENTION ?? "failed") as SandboxRetention;
  const runs = new RunService({
    store,
    agent,
    sandbox: new LocalWorktreeSandbox(sandboxRoot, retention),
    verifier: new CommandVerifier(),
    performanceVerifier: new CommandPerformanceVerifier(),
    resilienceVerifier: new CommandResilienceVerifier(),
    repositoryIndex,
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  const auth = new LocalDevelopmentAuth();
  const externalConnections = new MockExternalConnections();
  const platformKeys = new InMemoryPlatformApiKeys();
  const missions = new MissionRegistry();
  const projects = new InMemoryProjectRegistry();

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
  app.get("/api/v1/home", async () => {
    const summaries = await runs.listSummaries();
    const active = summaries.filter((run) => run.state === "RUNNING" || run.state === "QUEUED");
    const attention = summaries.filter(
      (run) => run.operationalStatus === "STUCK" || run.state === "FAILED",
    );
    const totalRecorded = summaries.reduce((sum, run) => sum + run.cost.total, 0);
    return {
      active,
      attention,
      recent: summaries.slice(0, 5),
      usage: {
        totalRecorded,
        hasKnownCost: summaries.some((run) => run.cost.total > 0),
        currency: "USD",
      },
    };
  });
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
  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id/recovery-capsule",
    async (request, reply) => {
      const capsule = await runs.recoveryCapsule(request.params.id);
      return capsule ? capsule : reply.code(404).send({ error: "RECOVERY_CAPSULE_NOT_FOUND" });
    },
  );
  app.post<{ Params: { id: string }; Body: { credentialReferences?: string[] } }>(
    "/api/v1/runs/:id/resume",
    async (request, reply) => {
      const body = resumeSchema.parse(request.body ?? {});
      try {
        return await runs.resume(request.params.id, body.credentialReferences ?? []);
      } catch (error) {
        return reply.code(409).send({
          error: "RESUME_REFUSED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  app.post("/api/v1/system/emergency-stop", async () => runs.emergencyStop());
  app.post("/api/v1/system/resume-new-runs", async () => {
    runs.resumeNewRuns();
    return { emergencyStopped: runs.isEmergencyStopped() };
  });
  app.get("/api/v1/system/status", async () => ({
    emergencyStopped: runs.isEmergencyStopped(),
  }));
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
  app.get("/api/v1/auth/config", async () => ({
    mode: "DEVELOPMENT",
    detail:
      "Xác thực môi trường phát triển đang hoạt động. Better Auth provider chưa được cấu hình.",
    providers: [
      { id: "email-password", status: "NOT_CONFIGURED" },
      { id: "github", status: "NOT_CONFIGURED" },
      { id: "google", status: "NOT_CONFIGURED" },
    ],
  }));
  app.get("/api/v1/projects", async () => ({
    durability: "PROCESS_LOCAL",
    projects: projects.list(),
  }));
  app.post("/api/v1/projects", async (request, reply) => {
    const body = projectSchema.parse(request.body);
    return reply.code(201).send(
      projects.create({
        name: body.name,
        repositoryPath: path.resolve(body.repositoryPath),
        ...(body.revision ? { revision: body.revision } : {}),
        ...(body.preferences ? { preferences: body.preferences } : {}),
      }),
    );
  });
  app.get("/api/v1/agents", async () => {
    const capabilities = await agent.capabilities();
    const nativeClaude = agent.name === "claude-code";
    return [
      {
        id: "claude-code",
        name: "Claude Code",
        available: nativeClaude,
        supported: true,
        active: nativeClaude,
        authMethod: "NATIVE_SESSION",
        capabilities: nativeClaude ? capabilities : null,
        detail: nativeClaude
          ? "Được cấu hình làm executor đang hoạt động. Claude Code sở hữu phiên xác thực native."
          : "MAF hỗ trợ nhưng chưa chọn làm executor của server này.",
      },
      {
        id: agent.name,
        name: agent.name === "native-cli" ? "Local fixture agent" : agent.name,
        available: true,
        supported: true,
        active: true,
        authMethod: "NOT_APPLICABLE",
        capabilities,
        detail: "Executor hiện được cấu hình trên server.",
      },
    ];
  });
  app.get("/api/v1/connections", async () => {
    return [
      {
        id: "claude-code",
        category: "AI_PROVIDER",
        provider: "Claude Code",
        method: "NATIVE_SESSION",
        status: "UNKNOWN",
        capability: "Executor CLI native",
        detail:
          "Chưa rõ trạng thái. Chạy Kiểm tra kết nối để xem Claude Code đã được cài chưa. Phiên đăng nhập vẫn do Claude sở hữu.",
      },
      {
        id: "openai-api",
        category: "AI_PROVIDER",
        provider: "OpenAI API",
        method: "CREDENTIAL_REFERENCE",
        status: "NOT_CONFIGURED",
        capability: "Chưa hỗ trợ trong bản build này",
        credentialReference: "credential://user/openai/default",
        detail:
          "MAF nhận tham chiếu credential, nhưng chưa có kho bí mật an toàn, bền vững hoặc executor OpenAI được cấu hình.",
      },
      {
        id: "development-auth",
        category: "MAF_ACCOUNT",
        provider: "Development authentication",
        method: "HEADER",
        status: "CONNECTED",
        capability: "Chỉ dùng cho môi trường phát triển local",
        detail: "Better Auth email, GitHub và Google sẽ khả dụng sau khi cấu hình phía server.",
      },
    ];
  });
  app.post<{ Params: { id: string } }>("/api/v1/connections/:id/test", async (request, reply) => {
    if (request.params.id !== "claude-code") {
      return reply.code(409).send({
        error: "CONNECTION_TEST_UNAVAILABLE",
        message: "Không thể kiểm tra kết nối này vì chưa có tích hợp provider thực thi được.",
      });
    }
    return claudeConnectionStatus();
  });
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
  app.post("/api/v1/platform-keys", async (request, reply) => {
    const body = platformKeySchema.parse(request.body);
    return reply.code(201).send(await platformKeys.issue(body.ownerId, body.scopes));
  });
  app.get<{ Querystring: { ownerId?: string } }>("/api/v1/platform-keys", async (request) =>
    platformKeys.list(request.query.ownerId ?? "development-user"),
  );
  app.post<{ Params: { id: string } }>("/api/v1/platform-keys/:id/revoke", async (request) => {
    await platformKeys.revoke(request.params.id);
    return { id: request.params.id, revoked: true };
  });
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
