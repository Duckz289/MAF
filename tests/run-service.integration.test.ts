import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { ACPAdapter } from "../src/infrastructure/acp-adapter";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import type { AgentAdapter } from "../src/domain/ports";
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

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
    expect(await telemetry.costPerVerifiedSuccess()).toBe(0);
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
});
