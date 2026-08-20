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
import type { AgentAdapter, VerifierPort } from "../src/domain/ports";
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

const harness = (sandboxRoot: string, agent?: AgentAdapter, verifier?: VerifierPort) => {
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
        capabilities: { livePolicyUpdate: true },
      }),
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
    verifier: verifier ?? new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, telemetry, store };
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
      prompt: "Fix image rendering in web",
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
      verificationAttempts: 1,
      repairAttempts: 0,
      moduleCountObserved: expect.any(Number),
      stabilizationInvalidations: expect.any(Number),
      verifiedSuccess: true,
    });
  });

  it("expands, stabilizes, enters STRICT, then leaves STRICT after unexpected diff scope", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service, telemetry } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Fix image rendering in web, then stabilize repeated edits",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const explanation = await service.modeExplanation(created.id);
    expect(
      completed?.executionMode,
      JSON.stringify({
        timeline: explanation.timeline,
        snapshots: (await service.signalSnapshots(created.id)).map((snapshot) => ({
          sequence: snapshot.sequence,
          checkpoint: snapshot.checkpoint,
          scope: snapshot.signals.scopeStabilized?.value,
          mechanical: snapshot.signals.mechanicalRemainingWork?.value,
          invalidations: snapshot.signals.stabilizationInvalidations?.value,
        })),
      }),
    ).toBe("GUIDED");
    expect(
      explanation.timeline.map((transition) => `${transition.from}->${transition.to}`),
    ).toEqual(["GUIDED->SOLO_NATIVE", "SOLO_NATIVE->STRICT", "STRICT->GUIDED"]);
    const strictSnapshot = (await service.signalSnapshots(created.id)).find(
      (snapshot) => snapshot.id === explanation.timeline[1]?.signalSnapshotId,
    );
    expect(strictSnapshot?.signals.scopeStabilized).toMatchObject({
      value: true,
      provenance: "HEURISTIC",
    });
    expect(strictSnapshot?.signals.mechanicalRemainingWork?.value).toBe(true);
    const reexpandedSnapshot = (await service.signalSnapshots(created.id)).find(
      (snapshot) => snapshot.id === explanation.timeline[2]?.signalSnapshotId,
    );
    expect(reexpandedSnapshot?.signals.scopeStabilized?.value).toBe(false);
    expect(reexpandedSnapshot?.signals.stabilizationInvalidations?.value).toBe(1);
    expect(
      reexpandedSnapshot?.evidence.some((evidence) =>
        evidence.summary.includes("Previously stabilized scope invalidated"),
      ),
    ).toBe(true);
    expect(telemetry.snapshot()[0]).toMatchObject({
      initialMode: "GUIDED",
      finalMode: "GUIDED",
      modeTransitions: 3,
      strictReexpansions: 1,
      verificationAttempts: 1,
      repairAttempts: 0,
      stabilizationInvalidations: 1,
    });
  });

  it("persists two trusted failures through one bounded repair and escalates mode", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Attempt a bounded repair that remains unverifiable",
      repositoryPath: fixture.path,
      verification: { expectedFile: "missing-proof.txt" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState).toBe("QUARANTINED");
    expect(completed?.retryCount).toBe(1);
    expect(completed?.executionMode).toBe("SOLO_NATIVE");
    const verifications = await service.verifications(created.id);
    expect(verifications).toHaveLength(2);
    expect(verifications.map((verification) => verification.attempt)).toEqual([1, 2]);
    expect(verifications.every((verification) => Boolean(verification.candidateId))).toBe(true);
    const snapshots = await service.signalSnapshots(created.id);
    expect(snapshots.at(-1)?.signals.repeatedVerifierFailures).toMatchObject({
      value: 2,
      provenance: "DETERMINISTIC",
    });
    const artifacts = await service.artifacts(created.id);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[1]?.metadata).toMatchObject({
      attempt: 2,
      parentCandidateId: artifacts[0]?.id,
    });
    const events = await service.events(created.id);
    expect(events.filter((event) => event.type === "VerificationRepairStarted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "VerificationRepairStopped")).toHaveLength(1);
  });

  it("accepts a repaired candidate only after the trusted verifier passes", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, telemetry } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Repair succeeds only after trusted evidence",
      repositoryPath: fixture.path,
      verification: { expectedFile: "repair-proof.txt" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
    const verifications = await service.verifications(created.id);
    expect(verifications.map((verification) => verification.state)).toEqual([
      "QUARANTINED",
      "VERIFIED",
    ]);
    expect(completed?.changedFiles).toEqual(
      expect.arrayContaining(["agent-output.md", "repair-proof.txt"]),
    );
    expect(telemetry.snapshot()[0]).toMatchObject({
      verificationAttempts: 2,
      repairAttempts: 1,
      verifierFailures: 1,
      verifiedSuccess: true,
    });
  });

  it("redacts trusted-verifier output before persistence and API-facing retrieval", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const verifierOutput = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "VERIFIER-PERSISTED-PRIVATE-KEY-BODY",
      "-----END ENCRYPTED PRIVATE KEY-----",
      "PASSWORD=hunter2hunter2 # verifier echoed environment",
    ].join("\n");
    const verifier: VerifierPort = {
      verify: async (run) => {
        const now = new Date().toISOString();
        return {
          id: crypto.randomUUID(),
          runId: run.id,
          type: "probe",
          state: "VERIFIED",
          exitCode: 0,
          output: verifierOutput,
          startedAt: now,
          completedAt: now,
        };
      },
      cancel: async () => {},
    };
    const { service } = harness(fixture.sandboxRoot, undefined, verifier);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);

    const exposed = JSON.stringify({
      verifications: await service.verifications(created.id),
      events: await service.events(created.id),
    });
    expect(exposed).not.toContain("VERIFIER-PERSISTED-PRIVATE-KEY-BODY");
    expect(exposed).not.toContain("hunter2hunter2");
    expect(exposed).not.toContain("BEGIN ENCRYPTED PRIVATE KEY");
    expect(exposed).toContain("REDACTED PRIVATE KEY");
  });

  it("rejects secret-bearing durable locators and raw agent credential inputs", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const rawToken = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";

    await expect(
      service.create({
        prompt: "probe revision boundary",
        repositoryPath: fixture.path,
        revision: rawToken,
      }),
    ).rejects.toThrow("Revision contains credential-shaped text");
    await expect(
      service.create({
        prompt: "probe expected-file boundary",
        repositoryPath: fixture.path,
        verification: { expectedFile: rawToken },
      }),
    ).rejects.toThrow("Expected-file path contains credential-shaped text");
    await expect(
      service.create({
        prompt: "probe reference boundary",
        repositoryPath: fixture.path,
        credentialReferences: [rawToken],
      }),
    ).rejects.toThrow("credential:// references");
  });

  it("redacts adversarial changed filenames from runs and runtime-signal persistence", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const rawFilename = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";
    const created = await service.create({
      prompt: "Write secret-shaped filename",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);

    const exposed = JSON.stringify({
      run: await service.get(created.id),
      summaries: await service.listSummaries(),
      signals: await service.signalSnapshots(created.id),
      events: await service.events(created.id),
      artifacts: await service.artifacts(created.id),
    });
    expect(exposed).not.toContain(rawFilename);
    expect(exposed).toContain("redacted");
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
