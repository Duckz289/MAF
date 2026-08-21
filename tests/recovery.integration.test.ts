import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService, type RecoveryPolicy } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { RunStore } from "../src/domain/ports";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { runProcess } from "../src/infrastructure/process-utils";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
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

const harness = (sandboxRoot: string, recoveryPolicy?: Partial<RecoveryPolicy>) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const telemetry = new DomainTelemetryRecorder();
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
    // Retention must preserve non-VERIFIED sandboxes so a PAUSED run's workspace survives for resume.
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "failed"),
    verifier: new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
    ...(recoveryPolicy ? { recoveryPolicy } : {}),
  });
  return { service, telemetry, store };
};

describe("recovery plane", () => {
  it("auto-retries a network failure with a new bounded session and completes verified", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 1 });
    const created = await service.create({
      prompt: "simulate transient failure once",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    expect(
      completed?.verificationState,
      JSON.stringify({ error: completed?.error, events: events.map((event) => event.type) }),
    ).toBe("VERIFIED");
    const recovered = events.find((event) => event.type === "RecoveryAttempted");
    // Agent-reported errors are always classified AGENT_FAILURE regardless of their text — see
    // the "never trusts agent-reported error text" test below. AGENT_FAILURE is still bounded
    // auto-retryable, so the retry-then-succeed behavior under test is unaffected.
    expect(recovered?.data).toMatchObject({
      classification: "AGENT_FAILURE",
      attempt: 1,
      strategy: "NEW_BOUNDED_SESSION",
    });
    // No capsule should exist for a run that recovered on its own — recovery evidence is only
    // captured when a run actually reaches a paused/unrecoverable outcome.
    const capsuleResponse = await service.recoveryCapsule(created.id);
    expect(capsuleResponse).toBeUndefined();
  });

  it("pauses with a durable recovery capsule on a non-retryable harness-side failure", async () => {
    // A directory that is not a git repository at all makes LocalWorktreeSandbox.create() throw
    // before any agent session starts — a harness-authored error ("...Git worktree..."), not an
    // agent-reported one, so it is genuinely eligible for full pattern-matched classification
    // (ENVIRONMENT_FAILURE), which is not auto-retryable.
    const notARepository = await mkdtemp(path.join(tmpdir(), "adaptive-harness-not-a-repo-"));
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "adaptive-harness-sandboxes-"));
    try {
      const { service } = harness(sandboxRoot);
      const created = await service.create({
        prompt: "this will never reach an agent session",
        repositoryPath: notARepository,
        verification: { expectedFile: "agent-output.md" },
      });
      const paused = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "PAUSED" || run?.state === "FAILED" || run?.state === "COMPLETED",
      );
      await service.waitForIdle(created.id);
      expect(paused?.state, paused?.error).toBe("PAUSED");
      const capsule = await service.recoveryCapsule(created.id);
      expect(capsule).toMatchObject({
        runId: created.id,
        recoveryReason: "ENVIRONMENT_FAILURE",
        remainingBudget: null,
        agent: "native-cli",
      });
      // No sandbox was ever created, so there is nothing to preserve a workspace path for.
      expect(capsule?.workspacePath).toBeUndefined();
      const events = await service.events(created.id);
      expect(events.some((event) => event.type === "RunPaused")).toBe(true);
      // A non-retryable failure must not have attempted an automatic retry.
      expect(events.some((event) => event.type === "RecoveryAttempted")).toBe(false);
    } finally {
      await rm(notARepository, { recursive: true, force: true });
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("keeps private-key bodies out of a recovery capsule captured after a persisted candidate", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
    const created = await service.create({
      prompt: "Leak consecutive private keys and fail during repair",
      repositoryPath: fixture.path,
      // The first candidate is captured and persisted, then this missing file starts a repair
      // session that the fixture deliberately fails. Recovery therefore has real candidate
      // artifacts to compose into the durable capsule.
      verification: { expectedFile: "never-written.md" },
    });
    const paused = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "FAILED" || run?.state === "COMPLETED",
    );
    await service.waitForIdle(created.id);

    expect(paused?.state, paused?.error).toBe("PAUSED");
    const capsule = await service.recoveryCapsule(created.id);
    expect(capsule?.candidateLineage).toHaveLength(1);
    const serializedCapsule = JSON.stringify(capsule);
    expect(serializedCapsule).not.toContain("FIRST-PERSISTED-PRIVATE-KEY-BODY");
    expect(serializedCapsule).not.toContain("SECOND-PERSISTED-PRIVATE-KEY-BODY");
    expect(serializedCapsule).not.toContain("BEGIN RSA PRIVATE KEY");
    // Capsules retain candidate identity/digest/verification metadata, not diff-preview content.
    expect(capsule?.candidateLineage[0]?.digest).toBeTruthy();
  });

  it("redacts task goals and agent-controlled errors before run, summary, and capsule persistence", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
    const created = await service.create({
      prompt: "simulate secret-bearing failure with ghp_TTTT1111UUUU2222VVVV3333WWWW4444XXXX",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "FAILED" || run?.state === "COMPLETED",
    );
    await service.waitForIdle(created.id);

    const persisted = JSON.stringify({
      run: await service.get(created.id),
      task: await store.getTask(created.taskId),
      summaries: await service.listSummaries(),
      capsule: await service.recoveryCapsule(created.id),
      events: await service.events(created.id),
    });
    for (const rawSecretFragment of [
      "ghp_TTTT1111UUUU2222VVVV3333WWWW4444XXXX",
      "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
      "ERROR-PERSISTED-PRIVATE-KEY-BODY",
      "BEGIN ENCRYPTED PRIVATE KEY",
    ]) {
      expect(persisted).not.toContain(rawSecretFragment);
    }
    expect(persisted).toContain("REDACTED PRIVATE KEY");
    expect(persisted).toContain("redacted");
  });

  it(
    "never lets agent-reported error text masquerade as a different failure classification",
    { timeout: 30_000 },
    async () => {
      // This trigger emits an agent `error` event whose text ("Invalid API key: authentication
      // failed") reads exactly like the CREDENTIAL_FAILURE pattern — a misclassification here
      // would let an agent's own claim about itself become durable "system-determined" recovery
      // evidence. It must be classified AGENT_FAILURE regardless.
      const fixture = await createFixtureRepository();
      fixtures.push(fixture);
      const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
      const created = await service.create({
        prompt: "simulate credential failure",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const paused = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "PAUSED" || run?.state === "FAILED" || run?.state === "COMPLETED",
      );
      await service.waitForIdle(created.id);
      expect(paused?.state, paused?.error).toBe("PAUSED");
      const capsule = await service.recoveryCapsule(created.id);
      expect(capsule?.recoveryReason).toBe("AGENT_FAILURE");
      expect(capsule?.recoveryReason).not.toBe("CREDENTIAL_FAILURE");
    },
  );

  it(
    "resumes a paused run from its capsule and completes when the source revision is unchanged",
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixtureRepository();
      fixtures.push(fixture);
      // maxRecoveryAttempts: 0 forces an immediate pause on the first transient failure instead
      // of an automatic retry, so resume() is what actually drives the second attempt.
      const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
      const created = await service.create({
        prompt: "simulate transient failure once",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const paused = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
      );
      await service.waitForIdle(created.id);
      expect(paused?.state, paused?.error).toBe("PAUSED");
      const capsuleBefore = await service.recoveryCapsule(created.id);
      expect(capsuleBefore?.recoveryReason).toBe("AGENT_FAILURE");

      const resumed = await service.resume(created.id);
      expect(resumed.state).toBe("RUNNING");
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "PAUSED" || run?.state === "FAILED",
      );
      await service.waitForIdle(created.id);
      expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
      const events = await service.events(created.id);
      expect(events.some((event) => event.type === "RunResumed")).toBe(true);
    },
  );

  it("refuses to resume when the source repository moved on while paused", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
    const created = await service.create({
      prompt: "simulate transient failure once",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const paused = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(paused?.state, paused?.error).toBe("PAUSED");

    // Move the SOURCE repository's HEAD forward while the paused run's sandbox worktree stays
    // frozen at the old commit — this is the exact drift the revision-conflict check exists for.
    await runProcess("git", ["commit", "--allow-empty", "-m", "repository moved on"], {
      cwd: fixture.path,
    });

    await expect(service.resume(created.id)).rejects.toThrow(/moved from/iu);
    const stillPaused = await service.get(created.id);
    expect(stillPaused?.state).toBe("PAUSED");
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "ResumeRefused")).toBe(true);
  });

  it("refuses to resume rather than treat an inconclusive revision check as no conflict", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
    const created = await service.create({
      prompt: "simulate transient failure once",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const capsule = await service.recoveryCapsule(created.id);
    expect(capsule?.resolvedRevision).toBeTruthy();
    if (!capsule) throw new Error("Expected a recovery capsule");
    // Simulate the only realistic way this field goes missing: a transient git failure at
    // capture time. Unknown must stay unknown rather than silently be treated as "unchanged".
    await store.saveRecoveryCapsule({ ...capsule, resolvedRevision: undefined });

    await expect(service.resume(created.id)).rejects.toThrow(/could not verify/iu);
    const stillPaused = await service.get(created.id);
    expect(stillPaused?.state).toBe("PAUSED");
    const events = await service.events(created.id);
    const refusal = events.find((event) => event.type === "ResumeRefused");
    expect(refusal?.data).toMatchObject({ reason: "REVISION_UNKNOWN" });
  });
});

describe("emergency stop", () => {
  it("cancels active runs, blocks new run creation, and preserves evidence", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Fix image rendering in web and await policy",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    // Let the run genuinely start (tool events observed) before stopping it mid-flight, rather
    // than racing emergencyStop() against a fixture that might finish first.
    await waitFor(
      () => service.events(created.id),
      (events) => events.some((event) => event.type === "AgentEvent"),
    );
    const { cancelledRunIds } = await service.emergencyStop();
    expect(cancelledRunIds).toContain(created.id);
    await service.waitForIdle(created.id);
    const cancelled = await service.get(created.id);
    expect(cancelled?.state).toBe("CANCELLED");
    // Evidence already recorded before the stop must remain intact.
    const events = await service.events(created.id);
    expect(events.length).toBeGreaterThan(0);

    await expect(
      service.create({
        prompt: "Write the fixture artifact",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      }),
    ).rejects.toThrow(/emergency stop/iu);

    service.resumeNewRuns();
    const afterResume = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(afterResume.id);
    const afterResumeRun = await service.get(afterResume.id);
    expect(afterResumeRun?.verificationState).toBe("VERIFIED");
  });

  it("refuses to resume while an emergency stop is active", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot, { maxRecoveryAttempts: 0 });
    const created = await service.create({
      prompt: "simulate transient failure once",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "PAUSED" || run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    await service.emergencyStop();
    await expect(service.resume(created.id)).rejects.toThrow(/emergency stop/iu);
  });

  it("closes the race window between create() and a concurrent emergency stop", async () => {
    // Without the fix, a run whose create() call is suspended mid-flight (registered in the
    // store but not yet in RunService's active map) is invisible to emergencyStop()'s
    // cancellation sweep and would still start an agent session after the stop already returned
    // to its caller. This wraps the store to trigger emergencyStop() at exactly that window.
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const baseStore = new InMemoryRunStore();
    const serviceRef: { current?: RunService } = {};
    const raceStore: RunStore = {
      createTask: baseStore.createTask.bind(baseStore),
      getTask: baseStore.getTask.bind(baseStore),
      createRun: async (run) => {
        await baseStore.createRun(run);
        await serviceRef.current?.emergencyStop();
      },
      updateRun: baseStore.updateRun.bind(baseStore),
      getRun: baseStore.getRun.bind(baseStore),
      listRuns: baseStore.listRuns.bind(baseStore),
      appendEvent: baseStore.appendEvent.bind(baseStore),
      listEvents: baseStore.listEvents.bind(baseStore),
      addArtifact: baseStore.addArtifact.bind(baseStore),
      listArtifacts: baseStore.listArtifacts.bind(baseStore),
      addVerification: baseStore.addVerification.bind(baseStore),
      listVerifications: baseStore.listVerifications.bind(baseStore),
      addSignalSnapshot: baseStore.addSignalSnapshot.bind(baseStore),
      listSignalSnapshots: baseStore.listSignalSnapshots.bind(baseStore),
      saveRecoveryCapsule: baseStore.saveRecoveryCapsule.bind(baseStore),
      getRecoveryCapsule: baseStore.getRecoveryCapsule.bind(baseStore),
      saveHealthSample: baseStore.saveHealthSample.bind(baseStore),
      listHealthSamples: baseStore.listHealthSamples.bind(baseStore),
      saveStrategyObservation: baseStore.saveStrategyObservation.bind(baseStore),
      listStrategyObservations: baseStore.listStrategyObservations.bind(baseStore),
      allocateStrategyCanaryOrdinal: baseStore.allocateStrategyCanaryOrdinal.bind(baseStore),
      saveDeliveryHandoff: baseStore.saveDeliveryHandoff.bind(baseStore),
      getDeliveryHandoff: baseStore.getDeliveryHandoff.bind(baseStore),
      saveCiEvidence: baseStore.saveCiEvidence.bind(baseStore),
      listCiEvidence: baseStore.listCiEvidence.bind(baseStore),
      saveProductionFeedback: baseStore.saveProductionFeedback.bind(baseStore),
      listProductionFeedback: baseStore.listProductionFeedback.bind(baseStore),
    };
    const brain = new InMemoryProjectBrain();
    const service = new RunService({
      store: raceStore,
      agent: new NativeCliAdapter({
        command: process.execPath,
        args: [
          "--import",
          pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
          path.resolve("src/fixtures/native-agent.ts"),
        ],
      }),
      sandbox: new LocalWorktreeSandbox(fixture.sandboxRoot, "none"),
      verifier: new CommandVerifier(),
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
    });
    serviceRef.current = service;

    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);
    const run = await service.get(created.id);
    expect(run?.state).toBe("CANCELLED");
    // No agent session should ever have started for this run.
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "AgentEvent")).toBe(false);
    expect(events.some((event) => event.type === "RunCancelled")).toBe(true);
  });
});
