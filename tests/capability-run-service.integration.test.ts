import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityExecutionObserver } from "../src/application/capability-execution";
import { CapabilityRegistry } from "../src/application/capability-registry";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type {
  CapabilityInput,
  CapabilityProvider,
  CapabilityResult,
} from "../src/domain/capability/provider";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

const fixtures: FixtureRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const resultFor = (input: CapabilityInput): CapabilityResult => ({
  provenance: {
    capabilityId: input.capabilityId,
    providerName: "fixture-provider",
    providerVersion: "1.0.0",
    invokedAt: new Date().toISOString(),
    durationMs: 1,
    candidateId: input.candidateId,
    diffDigest: input.diffDigest,
    baseRevision: input.sandbox.baseRevision,
  },
  execution: { outcome: "COMPLETED", exitCode: 0 },
  findings: [
    {
      target: "SECURITY.SENSITIVE_INPUT_FLOW",
      claim: "POSITIVE_FINDING",
      strength: "STRUCTURAL",
      file: "agent-output.md",
      ruleId: "fixture.bound-positive",
      message: "a bound exact-concern witness",
      severity: "HIGH",
    },
  ],
  coverage: { UNMODELLED: "PARTIAL" },
  negativeCoverage: { UNMODELLED: "UNSUPPORTED" },
  analyzedFiles: ["agent-output.md"],
});

const serviceWith = (
  sandboxRoot: string,
  fixtureProvider: CapabilityProvider,
  capabilityObserver?: CapabilityExecutionObserver,
) => {
  const registry = new CapabilityRegistry();
  registry.register(fixtureProvider);
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  return {
    store,
    service: new RunService({
      store,
      agent: new NativeCliAdapter({
        command: process.execPath,
        args: [
          "--import",
          pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
          path.resolve("src/fixtures/native-agent.ts"),
        ],
        capabilities: { livePolicyUpdate: true },
      }),
      sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
      verifier: new CommandVerifier(),
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
      capabilities: registry,
      ...(capabilityObserver ? { capabilityObserver } : {}),
    }),
  };
};

const executeFixture = async (
  fixtureProvider: CapabilityProvider,
  capabilityObserver?: CapabilityExecutionObserver,
) => {
  const fixture = await createFixtureRepository();
  fixtures.push(fixture);
  const runtime = serviceWith(fixture.sandboxRoot, fixtureProvider, capabilityObserver);
  const created = await runtime.service.create({
    prompt: "Write the fixture artifact",
    repositoryPath: fixture.path,
    verification: { expectedFile: "agent-output.md" },
  });
  await waitFor(
    () => runtime.service.get(created.id),
    (run) => run?.state === "COMPLETED" || run?.state === "FAILED" || run?.state === "PAUSED",
  );
  await runtime.service.waitForIdle(created.id);
  return {
    run: await runtime.service.get(created.id),
    events: await runtime.service.events(created.id),
  };
};

describe("RunService capability path", () => {
  it("executes after trusted verification and adds only the exact positive concern", async () => {
    const analyze = vi.fn(async (input: CapabilityInput) => resultFor(input));
    const runtime = await executeFixture({
      capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
      name: "fixture-provider",
      probe: async () => ({ available: true, version: "1.0.0", detail: "available" }),
      analyze,
    });

    expect(runtime.run?.verificationState, runtime.run?.error).toBe("VERIFIED");
    expect(analyze).toHaveBeenCalledTimes(1);
    const produced = runtime.events.find((event) => event.type === "CapabilityEvidenceProduced");
    expect(produced?.data).toMatchObject({
      resultCount: 1,
      concernWitnessCount: 1,
      results: [
        {
          binding: "MATCHED",
          status: "FAIL",
          findingCount: 1,
        },
      ],
    });
    const quality = runtime.events.find((event) => event.type === "QualityAssessed");
    expect(JSON.stringify(quality?.data)).toContain("SECURITY.SENSITIVE_INPUT_FLOW.ADEQUACY");
    expect(JSON.stringify(quality?.data)).toContain('"status":"FAIL"');
    expect(runtime.run?.trustState).toBe("CORRECTNESS_VERIFIED");
  });

  it("keeps an unavailable scanner distinct from a clean scan and preserves local operation", async () => {
    const analyze = vi.fn(async (input: CapabilityInput) => resultFor(input));
    const runtime = await executeFixture({
      capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
      name: "fixture-provider",
      probe: async () => ({ available: false, version: null, detail: "binary absent" }),
      analyze,
    });

    expect(runtime.run?.verificationState, runtime.run?.error).toBe("VERIFIED");
    expect(analyze).not.toHaveBeenCalled();
    const produced = runtime.events.find((event) => event.type === "CapabilityEvidenceProduced");
    expect(produced?.data).toMatchObject({
      concernWitnessCount: 0,
      results: [
        {
          outcome: "UNAVAILABLE",
          status: "NOT_CHECKED",
          findingCount: 0,
        },
      ],
    });
  });

  it("does not fail the mission when optional telemetry throws", async () => {
    const observer: CapabilityExecutionObserver = {
      record: () => {
        throw new Error("collector unavailable");
      },
    };
    const runtime = await executeFixture(
      {
        capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
        name: "fixture-provider",
        probe: async () => ({ available: true, version: "1.0.0", detail: "available" }),
        analyze: async (input) => resultFor(input),
      },
      observer,
    );

    expect(runtime.run?.verificationState, runtime.run?.error).toBe("VERIFIED");
    const produced = runtime.events.find((event) => event.type === "CapabilityEvidenceProduced");
    expect(produced?.data).toMatchObject({ results: [{ telemetry: "FAILED" }] });
  });
});
