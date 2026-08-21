import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { planEnforcement } from "../src/domain/policy-enforcement";
import type { AgentCapabilities, ModeChangedData } from "../src/domain/types";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import { createAdaptiveFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (sandboxRoot: string, capabilities?: Partial<AgentCapabilities>) => {
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
      ...(capabilities ? { capabilities } : {}),
    }),
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
    verifier: new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, telemetry, store };
};

describe("execution policy enforcement", () => {
  it(
    "enforces the full adaptive trajectory on a live session with acknowledged updates",
    { timeout: 40_000 },
    async () => {
      const fixture = await createAdaptiveFixtureRepository();
      fixtures.push(fixture);
      const { service, telemetry } = harness(fixture.sandboxRoot, { livePolicyUpdate: true });
      const created = await service.create({
        prompt: "Fix image rendering in web, then stabilize repeated edits with unexpected scope",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
        30_000,
      );
      await service.waitForIdle(created.id);
      const events = await service.events(created.id);
      const explanation = await service.modeExplanation(created.id);
      expect(
        completed?.verificationState,
        JSON.stringify({ error: completed?.error, timeline: explanation.timeline }),
      ).toBe("VERIFIED");
      expect(
        explanation.timeline.map(
          (transition) => `${transition.from}->${transition.to}:${transition.enforcement}`,
        ),
      ).toEqual([
        "GUIDED->SOLO_NATIVE:LIVE_UPDATE",
        "SOLO_NATIVE->STRICT:LIVE_UPDATE",
        "STRICT->GUIDED:LIVE_UPDATE",
      ]);
      // Every enforcement carries the session acknowledgement as evidence.
      const enforcementEvents = events.filter((event) => event.type === "ModeChanged");
      for (const event of enforcementEvents) {
        const data = event.data as ModeChangedData;
        expect(data.enforcement?.method).toBe("LIVE_UPDATE");
        expect(data.enforcement?.evidence).toMatchObject({
          acknowledgedMode: data.to,
          requestId: expect.any(String),
        });
      }
      // The request always precedes its enforcement, and an agent acknowledgement sits between.
      const types = events.map((event) => event.type);
      for (const enforcement of enforcementEvents) {
        const enforcementIndex = events.findIndex((event) => event.id === enforcement.id);
        const requestIndex = types.lastIndexOf("ModeChangeRequested", enforcementIndex);
        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(requestIndex).toBeLessThan(enforcementIndex);
        const ackBetween = events
          .slice(requestIndex, enforcementIndex)
          .some(
            (event) =>
              event.type === "AgentEvent" && (event.data as { type?: string }).type === "policy",
          );
        expect(ackBetween).toBe(true);
      }
      expect(completed?.desiredMode).toBe("GUIDED");
      expect(completed?.effectiveMode).toBe("GUIDED");
      expect(completed?.executionMode).toBe("GUIDED");
      expect(telemetry.snapshot()[0]).toMatchObject({
        policyLiveUpdates: 3,
        policySafeRestarts: 0,
        pendingPolicyAtCompletion: false,
        strictReexpansions: 1,
      });
    },
  );

  it("defers enforcement to the session boundary when live updates are unsupported", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot, {
      livePolicyUpdate: false,
      safeSessionRestart: false,
    });
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
    const events = await service.events(created.id);
    const requested = events.find((event) => event.type === "ModeChangeRequested");
    expect(requested?.data).toMatchObject({
      toDesired: "SOLO_NATIVE",
      effectiveMode: "GUIDED",
      plannedEnforcement: "DEFERRED_BOUNDARY",
    });
    const changed = events.find((event) => event.type === "ModeChanged");
    expect((changed?.data as ModeChangedData).enforcement).toMatchObject({
      method: "DEFERRED_BOUNDARY",
      evidence: { checkpoint: "agent-session-ended" },
    });
    // While the session ran, desired had already moved but effective had not: the enforcement
    // event comes after the last in-session agent event.
    const requestedIndex = events.findIndex((event) => event.id === requested?.id);
    const changedIndex = events.findIndex((event) => event.id === changed?.id);
    const lastAgentEventIndex = events.reduce(
      (latest, event, index) => (event.type === "AgentEvent" ? index : latest),
      -1,
    );
    expect(requestedIndex).toBeLessThan(changedIndex);
    expect(changedIndex).toBeGreaterThan(lastAgentEventIndex);
    expect(completed?.desiredMode).toBe("SOLO_NATIVE");
    expect(completed?.effectiveMode).toBe("SOLO_NATIVE");
  });

  it(
    "rejects a forged acknowledgement with the wrong requestId and only enforces the real one",
    { timeout: 40_000 },
    async () => {
      const fixture = await createAdaptiveFixtureRepository();
      fixtures.push(fixture);
      const { service } = harness(fixture.sandboxRoot, { livePolicyUpdate: true });
      const created = await service.create({
        prompt: "Fix image rendering in web and await policy with forge policy ack",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
        30_000,
      );
      await service.waitForIdle(created.id);
      expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
      const events = await service.events(created.id);
      const policyAcks = events.filter(
        (event) =>
          event.type === "AgentEvent" && (event.data as { type?: string }).type === "policy",
      );
      // Both the forged ack and the legitimate one were observed by the harness...
      expect(policyAcks.length).toBeGreaterThanOrEqual(2);
      const forged = policyAcks.find(
        (event) =>
          (event.data as { data: { requestId: string } }).data.requestId ===
          "forged-request-id-never-issued-by-harness",
      );
      expect(forged).toBeDefined();
      // ...but exactly one ModeChanged resulted, and its evidence binds the REAL requestId, never
      // the forged one. A pre-fix implementation that accepted any ack for the desired mode would
      // enforce twice or bind the forged id.
      const changed = events.filter((event) => event.type === "ModeChanged");
      expect(changed).toHaveLength(1);
      const enforcementEvidence = (changed[0]?.data as ModeChangedData).enforcement?.evidence as {
        requestId: string;
        acknowledgedRequestId: string;
      };
      expect(enforcementEvidence.requestId).not.toBe("forged-request-id-never-issued-by-harness");
      expect(enforcementEvidence.acknowledgedRequestId).toBe(enforcementEvidence.requestId);
      expect(completed?.effectiveMode).toBe("SOLO_NATIVE");
    },
  );

  it(
    "safely restarts a live session to broaden policy when only restart is supported",
    { timeout: 40_000 },
    async () => {
      const fixture = await createAdaptiveFixtureRepository();
      fixtures.push(fixture);
      const { service, telemetry } = harness(fixture.sandboxRoot, {
        livePolicyUpdate: false,
        safeSessionRestart: true,
      });
      const created = await service.create({
        prompt: "Fix image rendering in web and await policy",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      });
      const completed = await waitFor(
        () => service.get(created.id),
        (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
        30_000,
      );
      await service.waitForIdle(created.id);
      expect(completed?.verificationState, completed?.error).toBe("VERIFIED");
      const events = await service.events(created.id);
      const changed = events.find((event) => event.type === "ModeChanged");
      expect((changed?.data as ModeChangedData).enforcement).toMatchObject({
        method: "SAFE_RESTART",
        evidence: { restartCount: 1, workspacePreserved: true },
      });
      // The replacement session provably ran under the new policy: its process environment
      // carried the enforced mode, and the context was rebuilt for it.
      const sessionStarts = events.filter(
        (event) =>
          event.type === "AgentEvent" &&
          (event.data as { type?: string }).type === "message" &&
          typeof (event.data as { data?: { harnessMode?: unknown } }).data?.harnessMode ===
            "string",
      );
      expect(sessionStarts.length).toBe(2);
      expect((sessionStarts[0]?.data as { data: { harnessMode: string } }).data.harnessMode).toBe(
        "GUIDED",
      );
      expect((sessionStarts[1]?.data as { data: { harnessMode: string } }).data.harnessMode).toBe(
        "SOLO_NATIVE",
      );
      expect(events.some((event) => event.type === "ContextRebuilt")).toBe(true);
      expect(completed?.desiredMode).toBe("SOLO_NATIVE");
      expect(completed?.effectiveMode).toBe("SOLO_NATIVE");
      expect(telemetry.snapshot()[0]).toMatchObject({
        policySafeRestarts: 1,
        pendingPolicyAtCompletion: false,
      });
    },
  );

  it("applies externally requested transitions through the same enforcement path", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const rawTransitionToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const transitioned = await service.transition(
      created.id,
      "STRICT",
      `operator narrowed scope; token="${rawTransitionToken}"`,
      {
        operator: true,
        authorization: `Bearer ${rawTransitionToken}`,
        credentialReference: "UNSTRUCTURED-PROVIDER-SECRET-9f8e7d6c5b4a",
      },
    );
    expect(transitioned.desiredMode).toBe("STRICT");
    expect(transitioned.effectiveMode).toBe("STRICT");
    const events = await service.events(created.id);
    const changed = events.filter((event) => event.type === "ModeChanged").at(-1);
    expect((changed?.data as ModeChangedData).enforcement?.method).toBe("SESSION_BOUNDARY");
    expect(JSON.stringify(events)).not.toContain(rawTransitionToken);
    expect(JSON.stringify(events)).not.toContain("UNSTRUCTURED-PROVIDER-SECRET-9f8e7d6c5b4a");
    expect(JSON.stringify(changed)).toContain("[REDACTED]");
  });
});

describe("enforcement planner", () => {
  const context = { sessionActive: true, policyRestartsUsed: 0 };
  const decision = { to: "SOLO_NATIVE" as const, reason: "test", evidence: {} };

  it("applies immediately at a session boundary when no session is active", () => {
    expect(
      planEnforcement(
        decision,
        "GUIDED",
        { livePolicyUpdate: true, safeSessionRestart: true },
        { sessionActive: false, policyRestartsUsed: 0 },
      ),
    ).toBe("SESSION_BOUNDARY");
  });

  it("prefers live updates when genuinely supported", () => {
    expect(
      planEnforcement(
        decision,
        "GUIDED",
        { livePolicyUpdate: true, safeSessionRestart: true },
        context,
      ),
    ).toBe("LIVE_UPDATE");
  });

  it("restarts only for broadening transitions and within the restart bound", () => {
    const capabilities = { livePolicyUpdate: false, safeSessionRestart: true };
    expect(planEnforcement(decision, "GUIDED", capabilities, context)).toBe("SAFE_RESTART");
    expect(
      planEnforcement(decision, "GUIDED", capabilities, {
        sessionActive: true,
        policyRestartsUsed: 1,
      }),
    ).toBe("DEFERRED_BOUNDARY");
    expect(
      planEnforcement({ ...decision, to: "STRICT" }, "SOLO_NATIVE", capabilities, context),
    ).toBe("DEFERRED_BOUNDARY");
  });

  it("defers when the agent supports neither mechanism", () => {
    expect(
      planEnforcement(
        decision,
        "GUIDED",
        { livePolicyUpdate: false, safeSessionRestart: false },
        context,
      ),
    ).toBe("DEFERRED_BOUNDARY");
  });
});
