import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/application/capability-registry";
import { ControlCenterService, describeOptionalProviders } from "../src/application/control-center";
import { MissionRegistry } from "../src/application/mission-registry";
import { InMemoryProjectRegistry } from "../src/application/project-registry";
import { BuiltInWorkItemRegistry } from "../src/application/work-item-registry";
import {
  checkOutcomeLabel,
  checkOutcomeTone,
  deriveWhyRecords,
  formatMonetaryDisplay,
  isPassingCheck,
  knowledgeVisualAuthority,
  paginateItems,
  presentCostBreakdown,
} from "../src/domain/control-center";
import type { KnowledgeRecord } from "../src/domain/ports";
import type { Event, Run, Task } from "../src/domain/types";
import {
  assertGeneratedUiCannotBypassCommandPolicy,
  assertWorkItemCannotMutateTrust,
} from "../src/domain/work";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";

const digest = "a".repeat(64);

const knowledge = (overrides: Partial<KnowledgeRecord>): KnowledgeRecord => ({
  id: overrides.id ?? "knowledge-1",
  projectId: overrides.projectId ?? "project-1",
  revision: overrides.revision ?? "rev-1",
  kind: overrides.kind ?? "FACT",
  statement: overrides.statement ?? "module src/domain is a domain boundary",
  evidenceIds: overrides.evidenceIds ?? ["evidence-1"],
  status: overrides.status ?? "ACTIVE",
  createdAt: overrides.createdAt ?? "2026-08-25T00:00:00.000Z",
  provenance: overrides.provenance ?? {
    producer: "LOCAL_REPOSITORY_INDEX",
    source: "REPOSITORY_SNAPSHOT",
    sourceId: "src/domain/types.ts",
    sourceDigest: digest,
  },
  ...overrides,
});

const task = (id = "task-1"): Task => ({
  id,
  prompt: "Fix authorization on the session boundary",
  repositoryPath: "C:/does-not-exist",
  revision: "rev-1",
  createdAt: "2026-08-25T00:00:00.000Z",
  verification: { command: "npm test" },
  budget: { mode: "HARD", limitUsd: 4 },
});

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run-1",
  taskId: "task-1",
  state: "COMPLETED",
  executionMode: "STRICT",
  desiredMode: "GUIDED",
  effectiveMode: "STRICT",
  verificationState: "VERIFIED",
  trustState: "CORRECTNESS_VERIFIED",
  agent: "native-cli",
  model: "native",
  provider: "native",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:01:00.000Z",
  changedFiles: ["src/domain/types.ts"],
  cost: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
  usage: { input: 0, output: 0, cached: 0 },
  retryCount: 0,
  ...overrides,
});

const createService = async (
  options: {
    runs?: Run[];
    tasks?: Task[];
    events?: Event<unknown>[];
    knowledge?: KnowledgeRecord[];
  } = {},
) => {
  const store = new InMemoryRunStore();
  const projects = new InMemoryProjectRegistry();
  const brain = new InMemoryProjectBrain();
  const project = projects.create({
    name: "MAF",
    repositoryPath: "C:/does-not-exist",
    revision: "rev-1",
  });
  for (const item of options.tasks ?? [task()]) await store.createTask({ ...item });
  for (const item of options.runs ?? [run()]) await store.createRun({ ...item });
  for (const event of options.events ?? []) await store.appendEvent(event);
  for (const record of options.knowledge ?? []) {
    await brain.add({ ...record, projectId: project.id });
  }
  const service = new ControlCenterService({
    store,
    projects,
    missions: new MissionRegistry(),
    projectBrain: brain,
    repositoryIndex: new LocalRepositoryIndex(),
    capabilities: new CapabilityRegistry(),
    workItems: new BuiltInWorkItemRegistry(),
    optionalProviders: describeOptionalProviders({
      dependencyScannerEnabled: false,
      dependencyScannerCommand: false,
      staticAnalysisEnabled: false,
      staticAnalysisConfigured: false,
      repositoryIntelligenceConfigured: false,
      otlpEnabled: false,
      pricingConfigured: false,
    }),
  });
  return { service, store, projects, project, brain };
};

describe("control-center read-model authority", () => {
  it("keeps UNKNOWN and NOT_EXECUTED visually and semantically distinct from PASS", () => {
    expect(isPassingCheck("UNKNOWN")).toBe(false);
    expect(isPassingCheck("NOT_EXECUTED")).toBe(false);
    expect(isPassingCheck("NOT_CHECKED")).toBe(false);
    expect(isPassingCheck("PASS")).toBe(true);
    expect(checkOutcomeTone("UNKNOWN")).not.toBe("success");
    expect(checkOutcomeTone("NOT_EXECUTED")).not.toBe("success");
    expect(checkOutcomeTone("PASS")).toBe("success");
    expect(checkOutcomeLabel("UNKNOWN")).toBe("Unknown");
    expect(checkOutcomeLabel("NOT_EXECUTED")).toBe("Not executed");
    expect(checkOutcomeLabel("UNKNOWN")).not.toBe(checkOutcomeLabel("PASS"));
    expect(checkOutcomeLabel("NOT_EXECUTED")).not.toBe(checkOutcomeLabel("PASS"));
  });

  it("never renders UNKNOWN cost as $0", () => {
    const unknown = presentCostBreakdown({
      model: 0,
      sandbox: 0,
      verification: 0,
      retry: 0,
      recovery: 0,
      total: 0,
    });
    expect(unknown.total.status).toBe("UNKNOWN");
    expect(unknown.total.amountUsd).toBeNull();
    expect(unknown.total.display).toBe("unknown");
    expect(unknown.total.display).not.toContain("$0");
    expect(formatMonetaryDisplay("UNKNOWN", 0)).toBe("unknown");
    expect(formatMonetaryDisplay("UNKNOWN", 0)).not.toBe("$0.00");
    expect(formatMonetaryDisplay("EXACT", 0)).toBe("$0.00");
    expect(formatMonetaryDisplay("SUBSCRIPTION_INCLUDED", null)).toBe("included in subscription");
  });

  it("keeps stale and conflicted knowledge as distinct visual authorities", () => {
    expect(knowledgeVisualAuthority("FACT", "STALE")).toBe("STALE");
    expect(knowledgeVisualAuthority("FACT", "CONFLICTED")).toBe("CONFLICTED");
    expect(knowledgeVisualAuthority("INFERENCE", "CURRENT")).toBe("INFERENCE");
    expect(knowledgeVisualAuthority("FACT", "CURRENT")).toBe("DETERMINISTIC");
    expect(knowledgeVisualAuthority("FACT", "UNKNOWN")).toBe("UNKNOWN");
  });

  it("bounds event and evidence pages instead of serializing the full ledger", async () => {
    const events: Event<unknown>[] = Array.from({ length: 12 }, (_, index) => ({
      id: `event-${index}`,
      runId: "run-1",
      type: "AgentEvent",
      timestamp: `2026-08-25T00:00:${String(index).padStart(2, "0")}.000Z`,
      data: { index },
    }));
    const { service } = await createService({ events });
    const page = await service.events("run-1", { limit: 5 });
    expect(page?.items).toHaveLength(5);
    expect(page?.truncated).toBe(true);
    expect(page?.nextCursor).toBe("5");
    expect(page?.limit).toBe(5);
    expect(paginateItems([...Array(200).keys()], { limit: 100 }).items).toHaveLength(100);
    expect(paginateItems([...Array(200).keys()], { limit: 100 }).truncated).toBe(true);
  });

  it("represents recorded mission decision provenance without inventing explanations", async () => {
    const events: Event<unknown>[] = [
      {
        id: "evt-mode",
        runId: "run-1",
        type: "ModeChanged",
        timestamp: "2026-08-25T00:00:01.000Z",
        data: {
          from: "GUIDED",
          to: "STRICT",
          reason: "scope stabilized with mechanical remaining work",
          evidenceIds: ["snap-1"],
        },
      },
      {
        id: "evt-quality",
        runId: "run-1",
        type: "QualityAssessed",
        timestamp: "2026-08-25T00:00:02.000Z",
        data: {
          trustState: "CORRECTNESS_VERIFIED",
          unresolvedObligations: ["SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN"],
          candidateId: "cand-1",
        },
      },
    ];
    const why = deriveWhyRecords(events);
    expect(why.some((record) => record.question === "WHY_MODE")).toBe(true);
    expect(why.find((record) => record.question === "WHY_MODE")?.reason).toContain(
      "scope stabilized",
    );
    expect(why.find((record) => record.question === "WHY_MODE")?.provenance).toBe("RECORDED_EVENT");
    expect(why.find((record) => record.question === "WHY_MERGE_NOT_ELIGIBLE")?.reason).toContain(
      "SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN",
    );
    const { service } = await createService({ events });
    const inspect = await service.mission("run-1", "INSPECT");
    expect(inspect?.depth).toBe("INSPECT");
    if (inspect?.depth !== "INSPECT") throw new Error("expected inspect depth");
    expect(inspect.why.length).toBeGreaterThan(0);
    expect(inspect.trust.tone).not.toBe("success");
    expect(inspect.verification.state).toBe("NOT_EXECUTED");
    expect(inspect.verification.label).not.toBe("Pass");
  });

  it("exposes context budget and expansion from recorded ledger events", async () => {
    const { service } = await createService({
      events: [
        {
          id: "evt-built",
          runId: "run-1",
          type: "ContextBuilt",
          timestamp: "2026-08-25T00:00:01.000Z",
          data: {
            initialFiles: ["src/domain/types.ts"],
            initialModules: ["src/domain"],
            tokenEstimate: 120,
          },
        },
        {
          id: "evt-ledger",
          runId: "run-1",
          type: "ContextLedgerRecorded",
          timestamp: "2026-08-25T00:00:02.000Z",
          data: {
            buildStage: "INITIAL_RENDER",
            measuredCharacters: 2400,
            estimatedTokens: 600,
            pageCount: 1,
            budget: {
              maxPageRequests: 16,
              maxPageCount: 8,
              maxTextCharacters: 24_000,
            },
          },
        },
        {
          id: "evt-expand",
          runId: "run-1",
          type: "ContextExpanded",
          timestamp: "2026-08-25T00:00:03.000Z",
          data: { reason: "agent requested a bounded file slice" },
        },
      ],
    });
    const context = await service.context("run-1");
    expect(context?.initialWorkingSet.files).toEqual(["src/domain/types.ts"]);
    expect(context?.budget?.maxPageRequests).toBe(16);
    expect(context?.measuredCharacters).toBe(2400);
    expect(context?.expansionEvents).toBe(1);
    expect(context?.latestLedgerStage).toBe("INITIAL_RENDER");
  });

  it("treats unavailable optional providers as NONE system-health impact", () => {
    const providers = describeOptionalProviders({
      dependencyScannerEnabled: false,
      dependencyScannerCommand: false,
      staticAnalysisEnabled: false,
      staticAnalysisConfigured: false,
      repositoryIntelligenceConfigured: false,
      otlpEnabled: false,
      pricingConfigured: false,
    });
    expect(providers.every((provider) => provider.systemHealthImpact === "NONE")).toBe(true);
    expect(providers.every((provider) => provider.availability !== "AVAILABLE")).toBe(true);
    expect(providers.map((provider) => provider.id)).toEqual([
      "dependency-vulnerability",
      "static-analysis",
      "repository-intelligence",
      "otlp",
      "model-pricing-catalog",
    ]);
  });

  it("rejects PM mutations that attempt to write trust or verification", async () => {
    expect(() => assertWorkItemCannotMutateTrust({ trustState: "MERGE_ELIGIBLE" })).toThrow(
      /engineering authority field "trustState"/,
    );
    expect(() =>
      assertWorkItemCannotMutateTrust({ nested: { mergeEligibility: "ELIGIBLE" } }),
    ).toThrow(/mergeEligibility/);
    const { service } = await createService();
    const created = await service.applyWorkItem({
      type: "CREATE",
      projectId: "project-1",
      title: "Fix the session boundary",
    });
    expect(created).not.toHaveProperty("trustState");
    expect(created.status).toBe("BACKLOG");
    expect(created.provider).toBe("MAF_BUILTIN");
  });

  it("rejects generated-UI commands that would bypass policy even though generative UI is not shipped", () => {
    expect(() =>
      assertGeneratedUiCannotBypassCommandPolicy({
        source: "GENERATED_UI",
        command: "SET_TRUST",
        payload: { trustState: "MERGE_ELIGIBLE" },
      }),
    ).toThrow(/cannot bypass MAF command policy/);
    expect(() =>
      assertGeneratedUiCannotBypassCommandPolicy({
        source: "GENERATED_UI",
        command: "UPDATE_WORK_ITEM",
        payload: { verificationState: "VERIFIED" },
      }),
    ).toThrow(/engineering authority field/);
    expect(
      assertGeneratedUiCannotBypassCommandPolicy({
        source: "GENERATED_UI",
        command: "UPDATE_WORK_ITEM",
        payload: { status: "READY" },
      }),
    ).toBeUndefined();
  });

  it("bounds Project Map queries and does not dump a repository graph", async () => {
    const { service, project, brain } = await createService({
      knowledge: [
        knowledge({
          id: "stale-1",
          status: "STALE",
          statement: "stale module boundary",
          revision: "old-rev",
        }),
        knowledge({
          id: "conflict-1",
          status: "CONFLICTED",
          statement: "conflicted module boundary",
          evidenceIds: ["evidence-2"],
        }),
      ],
    });
    const map = await service.projectMap(project.id, { limit: 8, neighborhood: true });
    expect(map).toBeDefined();
    expect(map?.nodes.length ?? 0).toBeLessThanOrEqual(40);
    expect(map?.neighborhood.status).toBe("UNAVAILABLE");
    expect(map?.neighborhood.reason).toMatch(/not configured|not available/i);
    expect(map?.edges.every((edge) => edge.trustAuthority === "NONE")).toBe(true);
    const page = await service.projectKnowledge(project.id, { limit: 10 });
    expect(page?.items.some((item) => item.authority === "STALE")).toBe(true);
    expect(page?.items.some((item) => item.authority === "CONFLICTED")).toBe(true);
    expect(
      page?.items.some((item) => item.authority === "STALE") &&
        page?.items.some((item) => item.authority === "CONFLICTED"),
    ).toBe(true);
    await brain.add(
      knowledge({
        id: "evidence-row",
        kind: "EVIDENCE",
        statement: "file digest",
        evidenceIds: [],
        projectId: project.id,
      }),
    );
  });

  it("keeps SIMPLE mission cost UNKNOWN rather than $0 when the ledger is empty", async () => {
    const { service } = await createService();
    const simple = await service.mission("run-1", "SIMPLE");
    expect(simple?.depth).toBe("SIMPLE");
    expect(simple?.cost.total.status).toBe("UNKNOWN");
    expect(simple?.cost.total.display).toBe("unknown");
    expect(simple?.cost.costPerDurableVerifiedSuccess).toBeNull();
    expect(simple?.trust.state).toBe("CORRECTNESS_VERIFIED");
    expect(simple?.trust.tone).not.toBe("success");
  });
});
