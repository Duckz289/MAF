import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { ACPAdapter } from "../src/infrastructure/acp-adapter";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import type { AgentAdapter } from "../src/domain/ports";
import {
  createAdaptiveFixtureRepository,
  createFixtureRepository,
  type FixtureRepository,
  waitFor,
} from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (sandboxRoot: string, agent?: AgentAdapter) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const telemetry = new DomainTelemetryRecorder();
  const service = new RunService({
    store,
    agent:
      agent ??
      new NativeCliAdapter({
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
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, telemetry };
};

describe("single native-agent execution", () => {
  it("captures a diff and reaches VERIFIED", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, telemetry } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const lifecycle = await service.events(created.id);
    expect(
      completed?.verificationState,
      JSON.stringify({ error: completed?.error, lifecycle }),
    ).toBe("VERIFIED");
    expect(completed?.changedFiles).toContain("agent-output.md");
    expect((await service.artifacts(created.id))[0]?.kind).toBe("DIFF");
    expect(await telemetry.costPerVerifiedSuccess()).toBeNull();
  });

  it("quarantines an unverifiable run and records a mode transition", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact with coupled investigation",
      repositoryPath: fixture.path,
      verification: { expectedFile: "missing-proof.txt" },
      signals: { rootCauseUncertainty: 0.9, crossModuleEdges: 5 },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("QUARANTINED");
    expect(completed?.executionMode).toBe("SOLO_NATIVE");
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "ModeChanged")).toBe(true);
    expect(events.some((event) => event.type === "VerificationChanged")).toBe(true);
  });

  it("runs a first-class ACP v1 agent through the official SDK", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const adapter = new ACPAdapter({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        path.resolve("src/fixtures/acp-agent.ts"),
      ],
    });
    const { service } = harness(fixture.sandboxRoot, adapter);
    const created = await service.create({
      prompt: "Execute through ACP",
      repositoryPath: fixture.path,
      verification: { expectedFile: "acp-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
    expect(completed?.agent).toBe("acp");
    expect(completed?.changedFiles).toContain("acp-output.md");
    expect((await service.events(created.id)).some((event) => event.type === "AgentEvent")).toBe(
      true,
    );
  });

  it("moves GUIDED to SOLO_NATIVE from observed repository expansion", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service, telemetry } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Fix image rendering in frontend",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
    expect(completed?.executionMode).toBe("SOLO_NATIVE");
    const snapshots = await service.signalSnapshots(created.id);
    expect(
      snapshots.some(
        (snapshot) =>
          Number(snapshot.signals.dependencyExpansion?.value) >= 3 &&
          Number(snapshot.signals.crossModuleEdges?.value) >= 3,
      ),
    ).toBe(true);
    const explanation = await service.modeExplanation(created.id);
    expect(explanation.timeline).toMatchObject([
      {
        from: "GUIDED",
        to: "SOLO_NATIVE",
        signalSnapshotId: expect.any(String),
      },
    ]);
    expect(explanation.latestSignals.touchedModules?.provenance).toBe("DETERMINISTIC");
    expect(telemetry.snapshot()[0]).toMatchObject({
      signalSnapshots: expect.any(Number),
      dependencyExpansion: expect.any(Number),
      touchedModules: expect.any(Number),
      crossModuleEdges: expect.any(Number),
      contextExpansion: expect.any(Number),
      verifiedSuccess: true,
    });
  });

  it("moves SOLO_NATIVE to STRICT only after observed scope stabilization", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Fix image rendering in frontend, then stabilize repeated edits",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.executionMode).toBe("STRICT");
    const explanation = await service.modeExplanation(created.id);
    expect(
      explanation.timeline.map((transition) => `${transition.from}->${transition.to}`),
    ).toEqual(["GUIDED->SOLO_NATIVE", "SOLO_NATIVE->STRICT"]);
    const strictSnapshot = (await service.signalSnapshots(created.id)).find(
      (snapshot) => snapshot.id === explanation.timeline[1]?.signalSnapshotId,
    );
    expect(strictSnapshot?.signals.scopeStabilized).toMatchObject({
      value: true,
      provenance: "HEURISTIC",
    });
    expect(strictSnapshot?.signals.mechanicalRemainingWork?.value).toBe(true);
  });

  it("proves the local agent receives references but not managed provider secrets", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const previous = process.env.MAF_MANAGED_PROVIDER_SECRET;
    process.env.MAF_MANAGED_PROVIDER_SECRET = "sk-test-managed-secret-that-must-not-cross";
    try {
      const { service, telemetry } = harness(fixture.sandboxRoot);
      const created = await service.create({
        prompt: "Run credential boundary probe",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
        credentialReferences: ["credential://owner/provider-key"],
      });
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
      );
      await service.waitForIdle(created.id);
      expect(completed?.verificationState).toBe("VERIFIED");
      const serializedEvents = JSON.stringify(await service.events(created.id));
      const serializedTelemetry = JSON.stringify(telemetry.snapshot());
      const artifact = (await service.artifacts(created.id))[0];
      expect(serializedEvents).not.toContain("sk-test-managed-secret-that-must-not-cross");
      expect(serializedTelemetry).not.toContain("sk-test-managed-secret-that-must-not-cross");
      expect(JSON.stringify(artifact)).not.toContain("sk-test-managed-secret-that-must-not-cross");
      expect(JSON.stringify(artifact)).toContain("credential://owner/provider-key");
      expect(serializedEvents).toContain("REFERENCE_ONLY");
    } finally {
      if (previous === undefined) delete process.env.MAF_MANAGED_PROVIDER_SECRET;
      else process.env.MAF_MANAGED_PROVIDER_SECRET = previous;
    }
  });
});
