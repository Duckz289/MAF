import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { CapabilityRegistry } from "../application/capability-registry";
import { GuidedContextBuilder } from "../application/context-builder";
import { ContextNavigationService } from "../application/context-navigation";
import { ControlCenterService, describeOptionalProviders } from "../application/control-center";
import { MissionRegistry } from "../application/mission-registry";
import { InMemoryProjectRegistry } from "../application/project-registry";
import { RunService } from "../application/run-service";
import { EvidenceRuntimeSignalCollector } from "../application/runtime-signal-collector";
import { BuiltInWorkItemRegistry } from "../application/work-item-registry";
import type { ProjectBrain, RunStore } from "../domain/ports";
import { projectIdentity } from "../domain/project-identity";
import type { RepositoryIntelligenceProvider } from "../domain/repository-intelligence";
import { redactSensitiveData } from "../domain/security";
import { assessVerificationAuthority } from "../domain/verification-evidence";
import { normalizeVerificationSpecification } from "../domain/verification-spec";
import { assertWorkItemCannotMutateTrust } from "../domain/work";
import { FileSystemAgentSkillRegistry } from "../infrastructure/agent-skill-registry";
import { AntigravityCliAdapter } from "../infrastructure/antigravity-cli-adapter";
import { LocalBoundedProcessRunner } from "../infrastructure/bounded-process-runner";
import { ClaudeCodeAdapter } from "../infrastructure/claude-code-adapter";
import { CodexCliAdapter } from "../infrastructure/codex-cli-adapter";
import { LocalContextPageSource } from "../infrastructure/context-page-source";
import { InMemoryPlatformApiKeys, LocalDevelopmentAuth } from "../infrastructure/credentials";
import { LocalWorktreeSandbox, type SandboxRetention } from "../infrastructure/local-worktree";
import { InMemoryRunStore } from "../infrastructure/memory-store";
import {
  NativeAgentAuthManager,
  resolveAntigravityCommand,
  resolveCodexCommand,
} from "../infrastructure/native-agent-auth";
import { NativeCliAdapter } from "../infrastructure/native-cli-adapter";
import { OtelCapabilityExecutionObserver } from "../infrastructure/otel-capability-observer";
import { startOtelTraceRuntime } from "../infrastructure/otel-runtime";
import { CommandPerformanceVerifier } from "../infrastructure/performance-verifier";
import { PostgresRunStore } from "../infrastructure/postgres/store";
import {
  InMemoryProjectBrain,
  LocalRepositoryIndex,
  OptionalCodebaseMemoryIndex,
  PostgresProjectBrain,
} from "../infrastructure/project-brain";
import {
  browseDirectory,
  defaultBrowseStart,
  detectProject,
  listFilesystemRoots,
} from "../infrastructure/project-detection";
import { ProviderConnectionRegistry } from "../infrastructure/provider-connections";
import {
  OpenGrepAdapter,
  type OpenGrepRuleManifest,
} from "../infrastructure/providers/opengrep-adapter";
import { OsvScannerAdapter } from "../infrastructure/providers/osv-scanner-adapter";
import {
  loadScipRepositoryIntelligenceManifest,
  ScipRepositoryIntelligenceAdapter,
} from "../infrastructure/providers/scip-repository-intelligence-adapter";
import { CommandResilienceVerifier } from "../infrastructure/resilience-verifier";
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
    .superRefine((value, context) => {
      const normalized = normalizeVerificationSpecification(value);
      for (const reason of normalized.invalidReasons) {
        context.addIssue({ code: "custom", message: reason });
      }
    })
    .optional(),
  missionBinding: z
    .object({ missionId: z.string().min(1).max(200), nodeId: z.string().min(1).max(200) })
    .strict()
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
      evidenceInputs: z.array(z.string().min(1).max(1_000)).max(50).optional(),
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
  scopePaths: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  scopeExclusions: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  acceptanceCriteriaAmbiguous: z.boolean().optional(),
  expectedEvidence: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  requestedAuthority: z
    .array(
      z.enum([
        "READ_BOUNDED_CONTEXT",
        "REQUEST_CONTEXT_PAGE",
        "READ_SANDBOX",
        "WRITE_SANDBOX",
        "RUN_SANDBOX_COMMAND",
        "SUBMIT_CANDIDATE",
        "ACCESS_RAW_CREDENTIALS",
        "BYPASS_VERIFICATION",
        "ALTER_TRUST_CONSTITUTION",
        "SELF_PROMOTE_POLICY",
        "MERGE_OR_DEPLOY",
      ]),
    )
    .max(20)
    .optional(),
  skillIds: z
    .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u))
    .max(32)
    .optional(),
});
const healthLedgerQuerySchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  // The health ledger keys samples by the deterministic repository identity RunService already
  // computes (see projectIdentity), not the MAF project-registry id. Accepting repositoryPath here
  // lets the UI scope the ledger to "this project" without duplicating that derivation client-side.
  repositoryPath: z.string().min(1).max(4_000).optional(),
});
const ciEvidenceRequestSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  externalRunId: z.string().trim().min(1).max(500),
});
const productionFeedbackRequestSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  externalEventId: z.string().trim().min(1).max(500),
});
const productionFeedbackQuerySchema = z.object({ projectId: z.string().min(1).max(200) });

const transitionSchema = z.object({
  to: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]),
  reason: z.string().min(1).max(2_000),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const resumeSchema = z.object({
  credentialReferences: z.array(z.string().startsWith("credential://")).max(20).optional(),
});

const projectPreferencesSchema = z.object({
  providerPreference: z.string().max(120).optional(),
  qualityPreference: z.enum(["FAST", "BALANCED", "HIGH", "CRITICAL"]).optional(),
  budgetPreference: z.enum(["AUTO", "CUSTOM"]).optional(),
  executionModePreference: z.enum(["AUTO", "STRICT", "GUIDED", "SOLO_NATIVE"]).optional(),
  budgetLimitUsd: z.number().nonnegative().max(100_000).optional(),
  budgetMode: z.enum(["ADVISORY", "HARD"]).optional(),
});
const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryPath: z.string().trim().min(1).max(4_000),
  revision: z.string().trim().min(1).max(500).optional(),
  preferences: projectPreferencesSchema.optional(),
});
const filesystemBrowseQuerySchema = z.object({ path: z.string().min(1).max(4_000).optional() });
const filesystemDetectSchema = z.object({ repositoryPath: z.string().trim().min(1).max(4_000) });

const platformKeySchema = z.object({
  ownerId: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1).max(120)).min(1).max(20),
});

const providerConnectionSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("ENVIRONMENT"),
    environmentVariable: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    source: z.literal("LOCAL_ENCRYPTED_VAULT"),
    apiKey: z.string().min(1).max(8_000),
    model: z.string().trim().min(1).max(200).optional(),
  }),
]);
const customEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(["OPENAI_COMPATIBLE", "ANTHROPIC_COMPATIBLE"]),
  baseUrl: z.string().trim().min(1).max(2_000),
  apiKey: z.string().min(1).max(8_000),
  model: z.string().trim().min(1).max(200),
  headers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        value: z.string().min(1).max(2_000),
        classification: z.enum(["PUBLIC", "SECRET"]),
      }),
    )
    .max(20)
    .optional(),
  timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
});

const controlCenterPageQuery = z.object({
  cursor: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const controlCenterMissionQuery = controlCenterPageQuery.extend({
  depth: z.enum(["SIMPLE", "ADVANCED", "INSPECT"]).optional(),
});
const controlCenterMapQuery = controlCenterPageQuery.extend({
  search: z.string().max(200).optional(),
  focus: z.string().max(500).optional(),
  neighborhood: z.enum(["true", "false"]).optional(),
});
const workItemCreateSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    title: z.string().min(1).max(240),
    description: z.string().max(4_000).optional(),
    priority: z.enum(["UNSET", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    owner: z.string().max(200).nullable().optional(),
    milestone: z.string().max(200).nullable().optional(),
    dependencyIds: z.array(z.string().min(1).max(200)).max(32).optional(),
  })
  .strict();

const missionProposalSchema = z
  .object({
    id: z.string().min(1).max(200),
    parentId: z.string().min(1).max(200).optional(),
    dependencyIds: z.array(z.string().min(1).max(200)).max(64).default([]),
    executionMode: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE"]).default("GUIDED"),
    agent: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    budget: z.number().nonnegative(),
    inputs: z.array(z.string().max(2_000)).max(128).default([]),
  })
  .strict();

const missionNodeFromProposal = (proposal: z.infer<typeof missionProposalSchema>) => ({
  ...proposal,
  state: proposal.dependencyIds.length > 0 ? ("BLOCKED" as const) : ("READY" as const),
  outputs: [],
  verificationState: "NOT_CHECKED" as const,
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

const environmentEnabled = (name: string): boolean =>
  process.env[name]?.trim().toLowerCase() === "true";

const boundedEnvironmentInteger = (name: string, fallback: number, maximum: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const configureRepositoryIntelligence = async (
  app: FastifyInstance,
): Promise<RepositoryIntelligenceProvider | undefined> => {
  if (!environmentEnabled("MAF_SCIP_ENABLED")) return undefined;
  const manifestPath = process.env.MAF_SCIP_MANIFEST_PATH?.trim();
  if (!manifestPath) {
    app.log.warn("Repository intelligence enabled without a trusted manifest path");
    return undefined;
  }
  try {
    const loaded = await loadScipRepositoryIntelligenceManifest(manifestPath);
    return new ScipRepositoryIntelligenceAdapter({
      manifest: loaded.manifest,
      indexPath: loaded.indexPath,
      timeoutMs: boundedEnvironmentInteger("MAF_SCIP_TIMEOUT_MS", 15_000, 120_000),
      bounds: {
        maxIndexBytes: boundedEnvironmentInteger(
          "MAF_SCIP_MAX_INDEX_BYTES",
          256 * 1024 * 1024,
          512 * 1024 * 1024,
        ),
        maxDocumentBytes: boundedEnvironmentInteger(
          "MAF_SCIP_MAX_DOCUMENT_BYTES",
          16 * 1024 * 1024,
          256 * 1024 * 1024,
        ),
        maxDocuments: boundedEnvironmentInteger("MAF_SCIP_MAX_DOCUMENTS", 100_000, 100_000),
        maxOccurrences: boundedEnvironmentInteger("MAF_SCIP_MAX_OCCURRENCES", 2_000_000, 5_000_000),
        maxResults: boundedEnvironmentInteger("MAF_SCIP_MAX_RESULTS", 1_000, 10_000),
      },
    });
  } catch {
    app.log.warn("Repository intelligence configuration was refused");
    return undefined;
  }
};

const registerOptionalCapabilities = async (
  registry: CapabilityRegistry,
  runner: LocalBoundedProcessRunner,
  app: FastifyInstance,
): Promise<void> => {
  if (environmentEnabled("MAF_OSV_SCANNER_ENABLED")) {
    const command = process.env.MAF_OSV_SCANNER_COMMAND?.trim();
    if (!command) {
      app.log.warn("Dependency-vulnerability capability enabled without an executable path");
    } else {
      try {
        registry.register(
          new OsvScannerAdapter({
            command,
            trustedConfigPath: path.resolve(
              process.env.MAF_OSV_SCANNER_CONFIG ?? path.join("config", "osv-scanner.toml"),
            ),
            timeoutMs: boundedEnvironmentInteger("MAF_OSV_SCANNER_TIMEOUT_MS", 120_000, 600_000),
            runner,
          }),
        );
      } catch {
        app.log.warn("Dependency-vulnerability capability configuration was refused");
      }
    }
  }

  if (environmentEnabled("MAF_OPENGREP_ENABLED")) {
    const command = process.env.MAF_OPENGREP_COMMAND?.trim();
    const rulesPath = process.env.MAF_OPENGREP_RULES_PATH?.trim();
    const rulesetDigest = process.env.MAF_OPENGREP_RULESET_DIGEST?.trim();
    const manifestPath = process.env.MAF_OPENGREP_MANIFEST_PATH?.trim();
    if (!command || !rulesPath || !rulesetDigest || !manifestPath) {
      app.log.warn("Static-analysis capability enabled without complete local rules configuration");
    } else {
      try {
        const manifestSource = await readFile(path.resolve(manifestPath), "utf8");
        if (Buffer.byteLength(manifestSource) > 1024 * 1024) {
          throw new Error("manifest exceeds its composition bound");
        }
        const manifest = JSON.parse(manifestSource) as OpenGrepRuleManifest;
        registry.register(
          new OpenGrepAdapter({
            command,
            rulesPath,
            rulesetDigest,
            manifest,
            timeoutMs: boundedEnvironmentInteger("MAF_OPENGREP_TIMEOUT_MS", 120_000, 600_000),
            runner,
          }),
        );
      } catch {
        app.log.warn("Static-analysis capability configuration was refused");
      }
    }
  }
};

export interface AppRuntime {
  app: FastifyInstance;
  runs: RunService;
  controlCenter: ControlCenterService;
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
  const brain: ProjectBrain = pool ? new PostgresProjectBrain(pool) : new InMemoryProjectBrain();
  const repositoryIndex = new OptionalCodebaseMemoryIndex(new LocalRepositoryIndex());
  const repositoryIntelligence = await configureRepositoryIntelligence(app);
  const contextNavigation = new ContextNavigationService(
    new LocalContextPageSource(repositoryIndex, brain, repositoryIntelligence),
  );
  const genericTelemetry = new DomainTelemetryRecorder();
  const telemetry = pool ? new PostgresTelemetrySink(pool, genericTelemetry) : genericTelemetry;
  const capabilities = new CapabilityRegistry();
  const capabilityRunner = new LocalBoundedProcessRunner(
    boundedEnvironmentInteger("MAF_CAPABILITY_MAX_OUTPUT_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024),
  );
  await registerOptionalCapabilities(capabilities, capabilityRunner, app);
  const otelRuntime = startOtelTraceRuntime();
  const capabilityObserver =
    otelRuntime.enabled && otelRuntime.tracer
      ? new OtelCapabilityExecutionObserver(otelRuntime.tracer)
      : undefined;
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
      : process.env.MAF_NATIVE_AGENT === "codex"
        ? new CodexCliAdapter({
            command: resolveCodexCommand(),
            ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
          })
        : process.env.MAF_NATIVE_AGENT === "antigravity"
          ? new AntigravityCliAdapter({
              command: resolveAntigravityCommand(),
              ...(process.env.ANTIGRAVITY_MODEL ? { model: process.env.ANTIGRAVITY_MODEL } : {}),
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
  const skillRoots = (process.env.MAF_SKILLS_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const skills = new FileSystemAgentSkillRegistry({ roots: skillRoots });
  const runs = new RunService({
    store,
    agent,
    sandbox: new LocalWorktreeSandbox(sandboxRoot, retention),
    verifier: new CommandVerifier(),
    performanceVerifier: new CommandPerformanceVerifier(),
    resilienceVerifier: new CommandResilienceVerifier(),
    repositoryIndex,
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain, undefined, repositoryIntelligence),
    contextNavigation,
    skills,
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
    capabilities,
    ...(capabilityObserver ? { capabilityObserver } : {}),
  });
  await runs.reconcileInterruptedRuns();
  const auth = new LocalDevelopmentAuth();
  const providerConnections = new ProviderConnectionRegistry();
  const nativeAuth = new NativeAgentAuthManager();
  const platformKeys = new InMemoryPlatformApiKeys();
  const missions = new MissionRegistry();
  const projects = new InMemoryProjectRegistry();
  const workItems = new BuiltInWorkItemRegistry();
  const controlCenter = new ControlCenterService({
    store,
    projects,
    missions,
    projectBrain: brain,
    repositoryIndex,
    capabilities,
    workItems,
    optionalProviders: describeOptionalProviders({
      dependencyScannerEnabled: environmentEnabled("MAF_OSV_SCANNER_ENABLED"),
      dependencyScannerCommand: Boolean(process.env.MAF_OSV_SCANNER_COMMAND?.trim()),
      staticAnalysisEnabled: environmentEnabled("MAF_OPENGREP_ENABLED"),
      staticAnalysisConfigured: Boolean(
        process.env.MAF_OPENGREP_COMMAND?.trim() &&
          process.env.MAF_OPENGREP_RULES_PATH?.trim() &&
          process.env.MAF_OPENGREP_RULESET_DIGEST?.trim() &&
          process.env.MAF_OPENGREP_MANIFEST_PATH?.trim(),
      ),
      repositoryIntelligenceConfigured: repositoryIntelligence !== undefined,
      otlpEnabled: otelRuntime.enabled,
      pricingConfigured: Boolean(process.env.MAF_LITELLM_PRICING_PATH?.trim()),
    }),
    ...(repositoryIntelligence ? { repositoryIntelligence } : {}),
    emergencyStop: () => runs.isEmergencyStopped(),
  });

  app.addHook("onClose", async () => {
    await otelRuntime.shutdown();
  });

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
    projectBrain: pool ? "postgres" : "memory",
    repositoryIndex: repositoryIndex.status(),
  }));
  app.post("/api/v1/runs", async (request, reply) => {
    const body = createRunSchema.parse(request.body);
    if (body.missionBinding) {
      // Resolve before creating durable work so a typo cannot mint an unbound mission claim.
      missions.node(body.missionBinding.missionId, body.missionBinding.nodeId);
    }
    const run = await runs.create(body);
    if (body.missionBinding) {
      missions.bindExecution(
        body.missionBinding.missionId,
        body.missionBinding.nodeId,
        run.taskId,
        run.id,
      );
    }
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
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/delivery", async (request, reply) => {
    const decision = await runs.delivery(request.params.id);
    return decision
      ? redactSensitiveData(decision)
      : reply.code(404).send({ error: "DELIVERY_HANDOFF_NOT_FOUND" });
  });
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/delivery/ci-evidence", async (request) => {
    const body = ciEvidenceRequestSchema.parse(request.body);
    return redactSensitiveData(await runs.collectCiEvidence(request.params.id, body));
  });
  app.get("/api/v1/production-feedback", async (request) => {
    const query = productionFeedbackQuerySchema.parse(request.query);
    return redactSensitiveData(await runs.productionFeedback(query.projectId));
  });
  app.post("/api/v1/production-feedback/collect", async (request) => {
    const body = productionFeedbackRequestSchema.parse(request.body);
    return redactSensitiveData(await runs.collectProductionFeedback(body));
  });
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
      if (!capsule) return reply.code(404).send({ error: "RECOVERY_CAPSULE_NOT_FOUND" });
      const {
        workspacePath: _workspacePath,
        repositoryPath: _repositoryPath,
        ...publicCapsule
      } = capsule;
      return redactSensitiveData({
        ...publicCapsule,
        workspacePreserved: capsule.workspacePath !== undefined,
      });
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
  // M11: codebase health ledger — samples plus trend/maintenance proposal. Never a score.
  app.get("/api/v1/health-ledger", async (request, reply) => {
    const parsed = healthLedgerQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_QUERY" });
    const projectId =
      parsed.data.projectId ??
      (parsed.data.repositoryPath ? projectIdentity(parsed.data.repositoryPath) : undefined);
    return redactSensitiveData(await runs.healthLedger(projectId));
  });
  // Smallest truthful projection over already-computed run state: only runs that genuinely need
  // explicit user authority (paused for recovery, blocked on assurance evidence, or a delivery
  // handoff pending/blocked on external approval) become a decision item. Retries, routine
  // verification, and in-progress runs are deliberately excluded — those are handled automatically.
  app.get("/api/v1/decisions", async () => {
    const summaries = await runs.listSummaries();
    const items: Array<Record<string, unknown>> = [];
    for (const run of summaries) {
      if (run.state === "PAUSED") {
        const capsule = await runs.recoveryCapsule(run.id);
        items.push({
          type: "RECOVERY",
          runId: run.id,
          task: run.task,
          projectId: projectIdentity(run.repositoryPath),
          updatedAt: run.updatedAt,
          recoveryReason: capsule?.recoveryReason ?? "UNKNOWN_FAILURE",
          recoveryDetail: capsule?.recoveryDetail,
          remainingBudget: capsule?.remainingBudget ?? null,
          costSpent: capsule?.costSpent.total ?? run.cost.total,
        });
        continue;
      }
      if (run.operationalStatus === "ASSURANCE_BLOCKED") {
        items.push({
          type: "ASSURANCE_BLOCKED",
          runId: run.id,
          task: run.task,
          projectId: projectIdentity(run.repositoryPath),
          updatedAt: run.updatedAt,
        });
        continue;
      }
      if (run.operationalStatus === "AWAITING_REVIEW") {
        const delivery = await runs.delivery(run.id);
        if (delivery && delivery.mergeEligibility !== "PENDING") {
          items.push({
            type: "DELIVERY",
            runId: run.id,
            task: run.task,
            projectId: projectIdentity(run.repositoryPath),
            updatedAt: run.updatedAt,
            mergeEligibility: delivery.mergeEligibility,
            knownWarnings: delivery.handoff.knownWarnings,
          });
        } else {
          items.push({
            type: "AWAITING_REVIEW",
            runId: run.id,
            task: run.task,
            projectId: projectIdentity(run.repositoryPath),
            updatedAt: run.updatedAt,
          });
        }
      }
    }
    return redactSensitiveData(items);
  });
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
  app.patch<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const body = projectPreferencesSchema.parse(request.body);
    const updated = projects.update(request.params.id, body);
    return updated ? updated : reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  });
  // Local-first bridge for the folder picker: the server already runs on the user's own machine,
  // so this lists real local directories instead of faking a browser file-system picker that
  // cannot hand back a usable absolute path. Never uploads repository contents.
  app.get("/api/v1/filesystem/roots", async () => ({
    roots: await listFilesystemRoots(),
    defaultPath: defaultBrowseStart(),
  }));
  app.get("/api/v1/filesystem/browse", async (request, reply) => {
    const parsed = filesystemBrowseQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_QUERY" });
    return browseDirectory(parsed.data.path ?? defaultBrowseStart());
  });
  app.post("/api/v1/filesystem/detect", async (request) => {
    const body = filesystemDetectSchema.parse(request.body);
    return detectProject(body.repositoryPath);
  });
  app.get("/api/v1/agents", async () => {
    const capabilities = await agent.capabilities();
    const nativeClaude = agent.name === "claude-code";
    const nativeCodex = agent.name === "codex-cli";
    const nativeAntigravity = agent.name === "antigravity-cli";
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
        id: "codex-cli",
        name: "Codex CLI",
        available: nativeCodex,
        supported: true,
        active: nativeCodex,
        authMethod: "NATIVE_SESSION",
        capabilities: nativeCodex ? capabilities : null,
        detail: nativeCodex
          ? "Được cấu hình làm executor. Codex CLI sở hữu phiên Sign in with ChatGPT và quota Codex."
          : "MAF hỗ trợ Codex CLI; đặt MAF_NATIVE_AGENT=codex sau khi chạy codex --login.",
      },
      {
        id: "antigravity-cli",
        name: "Antigravity CLI",
        available: nativeAntigravity,
        supported: true,
        active: nativeAntigravity,
        authMethod: "NATIVE_SESSION",
        capabilities: nativeAntigravity ? capabilities : null,
        detail: nativeAntigravity
          ? "Được cấu hình làm executor. Antigravity IDE sở hữu phiên Google và quota provider."
          : "MAF hỗ trợ Antigravity CLI; đăng nhập trong Antigravity IDE rồi đặt MAF_NATIVE_AGENT=antigravity.",
      },
      ...(nativeClaude || nativeCodex || nativeAntigravity
        ? []
        : [
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
          ]),
    ];
  });
  app.get("/api/v1/connections", async () => {
    return [
      ...(await nativeAuth.listWithAccount()),
      ...providerConnections.list("development-user"),
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
    if (["claude-code", "codex-cli", "antigravity-cli"].includes(request.params.id)) {
      const connection = nativeAuth.connection(request.params.id);
      return {
        status: connection.status,
        detail: connection.detail,
        lastCheckedAt: new Date().toISOString(),
      };
    }
    try {
      return providerConnections.test("development-user", request.params.id.replace(/-api$/u, ""));
    } catch (error) {
      return reply.code(404).send({
        error: "CONNECTION_NOT_FOUND",
        message: error instanceof Error ? error.message : "Connection not found",
      });
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/connections/:id/configure",
    async (request, reply) => {
      const body = providerConnectionSchema.parse(request.body);
      const providerId = request.params.id.replace(/-api$/u, "");
      try {
        const connection =
          body.source === "ENVIRONMENT"
            ? providerConnections.configureEnvironment(
                "development-user",
                providerId,
                body.environmentVariable,
                body.model,
              )
            : providerConnections.configureVault(
                "development-user",
                providerId,
                body.apiKey,
                body.model,
              );
        return reply.code(200).send(connection);
      } catch (error) {
        return reply.code(409).send({
          error: "CONNECTION_CONFIGURATION_REFUSED",
          message: error instanceof Error ? error.message : "Connection configuration was refused",
        });
      }
    },
  );
  app.post("/api/v1/connections/custom", async (request, reply) => {
    const body = customEndpointSchema.parse(request.body);
    try {
      return reply.code(201).send(
        providerConnections.configureCustom("development-user", {
          name: body.name,
          protocol: body.protocol,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          model: body.model,
          ...(body.headers ? { headers: body.headers } : {}),
          ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
        }),
      );
    } catch (error) {
      return reply.code(409).send({
        error: "CUSTOM_CONNECTION_REFUSED",
        message: error instanceof Error ? error.message : "Custom connection was refused",
      });
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/connections/:id/disconnect",
    async (request, reply) => {
      if (["claude-code", "codex-cli", "antigravity-cli"].includes(request.params.id)) {
        nativeAuth.disconnectFromMaf(request.params.id);
        return { id: request.params.id, disconnected: true, scope: "MAF_ONLY" };
      }
      try {
        providerConnections.disconnect("development-user", request.params.id);
        return { id: request.params.id, disconnected: true };
      } catch (error) {
        return reply.code(409).send({
          error: "CONNECTION_DISCONNECT_REFUSED",
          message: error instanceof Error ? error.message : "Connection cannot be disconnected",
        });
      }
    },
  );
  app.post<{ Params: { id: string } }>("/api/v1/connections/:id/login", async (request, reply) => {
    try {
      return nativeAuth.beginLogin(request.params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native login is unavailable";
      return reply.code(message === "CLI_UNAVAILABLE" ? 409 : 404).send({
        error: message,
        message:
          message === "CLI_UNAVAILABLE"
            ? "CLI chưa sẵn sàng. Hãy cài đặt theo hướng dẫn chính thức rồi thử lại."
            : "Provider không hỗ trợ native login.",
      });
    }
  });
  app.get<{ Params: { id: string; attemptId: string } }>(
    "/api/v1/connections/:id/login/:attemptId",
    async (request, reply) => {
      try {
        return nativeAuth.pollLogin(request.params.id, request.params.attemptId);
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "LOGIN_ATTEMPT_NOT_FOUND",
          message: "Không tìm thấy phiên đăng nhập.",
        });
      }
    },
  );
  app.delete<{ Params: { id: string; attemptId: string } }>(
    "/api/v1/connections/:id/login/:attemptId",
    async (request, reply) => {
      try {
        return nativeAuth.cancelLogin(request.params.id, request.params.attemptId);
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "LOGIN_ATTEMPT_NOT_FOUND",
          message: "Không tìm thấy phiên đăng nhập.",
        });
      }
    },
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
    reply
      .code(201)
      .send(missions.create(missionNodeFromProposal(missionProposalSchema.parse(request.body)))),
  );
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/split", async (request) => {
    const body = z
      .object({ parentId: z.string(), children: z.array(missionProposalSchema).min(2) })
      .strict()
      .parse(request.body);
    return missions.split(
      request.params.id,
      body.parentId,
      body.children.map(missionNodeFromProposal),
    );
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/merge", async (request) => {
    const body = z
      .object({ nodeIds: z.array(z.string()).min(2), merged: missionProposalSchema })
      .strict()
      .parse(request.body);
    return missions.merge(request.params.id, body.nodeIds, missionNodeFromProposal(body.merged));
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/promote", async (request) => {
    const body = z
      .object({ nodeId: z.string().min(1), runId: z.string().uuid() })
      .strict()
      .parse(request.body);
    const [run, handoff, artifacts, verifications] = await Promise.all([
      store.getRun(body.runId),
      store.getDeliveryHandoff(body.runId),
      store.listArtifacts(body.runId),
      store.listVerifications(body.runId),
    ]);
    const task = run ? await store.getTask(run.taskId) : undefined;
    const missionNode = missions.node(request.params.id, body.nodeId);
    if (
      !run ||
      !task ||
      !handoff ||
      run.state !== "COMPLETED" ||
      run.verificationState !== "VERIFIED" ||
      run.trustState !== "MERGE_ELIGIBLE" ||
      handoff.trustState !== "MERGE_ELIGIBLE"
    ) {
      throw new Error("Mission promotion requires a canonical merge-eligible run handoff");
    }
    const executionBinding = missionNode.executionBinding;
    if (
      executionBinding?.missionId !== request.params.id ||
      executionBinding.nodeId !== body.nodeId ||
      executionBinding.runId !== run.id ||
      executionBinding.taskId !== task.id ||
      task.missionBinding?.missionId !== request.params.id ||
      task.missionBinding.nodeId !== body.nodeId ||
      run.missionBinding?.missionId !== request.params.id ||
      run.missionBinding.nodeId !== body.nodeId
    ) {
      throw new Error(
        "Mission promotion requires the run that was bound to this exact mission node",
      );
    }
    const artifact = artifacts.find(
      (item) =>
        item.id === handoff.candidateId &&
        typeof item.digest === "string" &&
        item.digest === handoff.candidateDigest,
    );
    const verification = verifications.find(
      (item) =>
        item.id === handoff.verification.id &&
        item.state === "VERIFIED" &&
        item.candidateId === handoff.candidateId,
    );
    if (!artifact?.digest || !verification) {
      throw new Error("Mission promotion evidence binding is incomplete or inconsistent");
    }
    const authority = assessVerificationAuthority({
      verification,
      specification: task.verification,
      candidateDigest: artifact.digest,
    });
    if (!authority.authorized) {
      throw new Error(
        `Mission promotion verification authority is insufficient: ${authority.reasons.join("; ")}`,
      );
    }
    missions.bindVerification(
      request.params.id,
      body.nodeId,
      "VERIFIED",
      [artifact.uri],
      "MERGE_ELIGIBLE",
      {
        runId: run.id,
        candidateId: artifact.id,
        candidateDigest: artifact.digest,
        verificationId: verification.id,
      },
    );
    return missions.promote(request.params.id, body.nodeId, artifact.uri);
  });
  app.post<{ Params: { id: string } }>("/api/v1/missions/:id/collapse", async (request) => {
    const body = z.object({ parentId: z.string() }).parse(request.body);
    return missions.collapse(request.params.id, body.parentId);
  });

  app.get("/api/v1/control-center/overview", async () =>
    redactSensitiveData(await controlCenter.overview()),
  );
  app.get("/api/v1/control-center/providers", async () =>
    redactSensitiveData(await controlCenter.providerStatus()),
  );
  app.get("/api/v1/control-center/evolution", async () =>
    redactSensitiveData(await controlCenter.evolution()),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/projects/:id",
    async (request, reply) => {
      const summary = await controlCenter.projectSummary(request.params.id);
      return summary
        ? redactSensitiveData(summary)
        : reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/projects/:id/map",
    async (request, reply) => {
      const query = controlCenterMapQuery.parse(request.query);
      const map = await controlCenter.projectMap(request.params.id, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.focus !== undefined ? { focus: query.focus } : {}),
        neighborhood: query.neighborhood === "true",
      });
      return map ? redactSensitiveData(map) : reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/projects/:id/knowledge",
    async (request, reply) => {
      const query = controlCenterPageQuery.parse(request.query);
      const page = await controlCenter.projectKnowledge(request.params.id, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return page
        ? redactSensitiveData(page)
        : reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>("/api/v1/control-center/runs/:id", async (request, reply) => {
    const query = controlCenterMissionQuery.parse(request.query);
    const mission = await controlCenter.mission(request.params.id, query.depth ?? "SIMPLE");
    return mission
      ? redactSensitiveData(mission)
      : reply.code(404).send({ error: "RUN_NOT_FOUND" });
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/runs/:id/events",
    async (request, reply) => {
      const query = controlCenterPageQuery.parse(request.query);
      const page = await controlCenter.events(request.params.id, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return page ? redactSensitiveData(page) : reply.code(404).send({ error: "RUN_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/runs/:id/evidence",
    async (request, reply) => {
      const query = controlCenterPageQuery.parse(request.query);
      const page = await controlCenter.evidence(request.params.id, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return page ? redactSensitiveData(page) : reply.code(404).send({ error: "RUN_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/runs/:id/trust",
    async (request, reply) => {
      const inspection = await controlCenter.trust(request.params.id);
      return inspection
        ? redactSensitiveData(inspection)
        : reply.code(404).send({ error: "RUN_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/runs/:id/context",
    async (request, reply) => {
      const inspection = await controlCenter.context(request.params.id);
      return inspection
        ? redactSensitiveData(inspection)
        : reply.code(404).send({ error: "RUN_NOT_FOUND" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/control-center/runs/:id/why",
    async (request, reply) => {
      const inspection = await controlCenter.why(request.params.id);
      return inspection
        ? redactSensitiveData(inspection)
        : reply.code(404).send({ error: "RUN_NOT_FOUND" });
    },
  );
  app.get("/api/v1/control-center/work-items", async (request) => {
    const query = controlCenterPageQuery
      .extend({ projectId: z.string().max(200).optional() })
      .parse(request.query);
    return redactSensitiveData(
      await controlCenter.workItems(query.projectId, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      }),
    );
  });
  app.post("/api/v1/control-center/work-items", async (request, reply) => {
    assertWorkItemCannotMutateTrust(request.body);
    const body = workItemCreateSchema.parse(request.body);
    const item = await controlCenter.applyWorkItem({
      type: "CREATE",
      projectId: body.projectId,
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.owner !== undefined ? { owner: body.owner } : {}),
      ...(body.milestone !== undefined ? { milestone: body.milestone } : {}),
      ...(body.dependencyIds !== undefined ? { dependencyIds: body.dependencyIds } : {}),
    });
    return reply.code(201).send(redactSensitiveData(item));
  });

  const webRoot = path.resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.get("/*", (_request, reply) => reply.sendFile("index.html"));
  }

  return {
    app,
    runs,
    controlCenter,
    close: async () => {
      await app.close();
      if (pool) await pool.end();
    },
  };
};
