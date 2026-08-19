import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import {
  createFixtureRepository,
  createSecuritySensitiveFixtureRepository,
  type FixtureRepository,
} from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (sandboxRoot: string) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const service = new RunService({
    store,
    agent: new NativeCliAdapter({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        path.resolve("src/fixtures/native-agent.ts"),
      ],
    }),
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
    verifier: new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry: new DomainTelemetryRecorder(),
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service };
};

describe("task risk profiler and assurance planner (M5)", () => {
  it("computes a deterministic pre-execution risk profile and assurance plan from the initial context scope", async () => {
    const fixture = await createSecuritySensitiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Inspect the auth-service implementation for correctness",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);

    const profiled = events.find(
      (event) =>
        event.type === "RiskProfiled" &&
        (event.data as { stage?: string }).stage === "pre-execution",
    );
    expect(profiled).toBeDefined();
    const riskVector = (profiled?.data as { riskVector: Record<string, unknown> }).riskVector;
    expect(riskVector).toBeDefined();
    // Every dimension must be present — a vector, never a collapsed scalar.
    expect(Object.keys(riskVector)).toHaveLength(10);
    const security = riskVector.SecuritySensitivity as { level: string; provenance: string };
    expect(security.level).not.toBe("LOW");
    expect(security.provenance).toBe("DETERMINISTIC");

    const planned = events.find(
      (event) =>
        event.type === "AssurancePlanned" &&
        (event.data as { stage?: string }).stage === "pre-execution",
    );
    expect(planned).toBeDefined();
    const plan = (
      planned?.data as { plan: { required: string[]; reasons: Record<string, string> } }
    ).plan;
    expect(plan.required).toContain("SECURITY");
    expect(plan.reasons.SECURITY).toContain("auth");
  });

  it("refines the risk profile from the actual diff once one exists, using different evidence than the pre-execution estimate", async () => {
    const fixture = await createSecuritySensitiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Inspect the auth-service implementation for correctness",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);

    const diffStage = events.find(
      (event) =>
        event.type === "RiskProfiled" &&
        (event.data as { stage?: string }).stage === "diff-captured",
    );
    expect(diffStage).toBeDefined();
    // The fixture agent's actual diff only ever touches agent-output.md — not the security-
    // sensitive path the pre-execution estimate was scoped around — so the refined, ground-truth
    // assessment must genuinely differ rather than just echoing the earlier estimate.
    const riskVector = (diffStage?.data as { riskVector: Record<string, unknown> }).riskVector;
    const security = riskVector.SecuritySensitivity as { level: string; provenance: string };
    expect(security.provenance).toBe("HEURISTIC");
  });

  it("defaults qualityPreference to BALANCED when the request omits it, and threads an explicit CRITICAL preference through", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);

    const defaulted = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(defaulted.id);
    const defaultedEvents = await service.events(defaulted.id);
    const defaultedPlan = defaultedEvents.find(
      (event) =>
        event.type === "AssurancePlanned" &&
        (event.data as { stage?: string }).stage === "pre-execution",
    );
    expect((defaultedPlan?.data as { qualityPreference: string }).qualityPreference).toBe(
      "BALANCED",
    );

    const critical = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "CRITICAL",
    });
    await service.waitForIdle(critical.id);
    const criticalEvents = await service.events(critical.id);
    const criticalPlan = criticalEvents.find(
      (event) =>
        event.type === "AssurancePlanned" &&
        (event.data as { stage?: string }).stage === "pre-execution",
    );
    const planData = criticalPlan?.data as {
      qualityPreference: string;
      plan: { required: string[] };
    };
    expect(planData.qualityPreference).toBe("CRITICAL");
    // CRITICAL expands scope even for a low-risk change (see buildAssurancePlan).
    expect(planData.plan.required).toContain("RESILIENCE");
    expect(planData.plan.required).toContain("SECURITY");
  });
});
