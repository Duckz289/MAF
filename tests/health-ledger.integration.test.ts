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
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("M11 health ledger wiring", () => {
  it("appends a health sample per completed run and reports trend only from two samples", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
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
      sandbox: new LocalWorktreeSandbox(fixture.sandboxRoot, "none"),
      verifier: new CommandVerifier(),
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
    });

    // One sample alone is a baseline, not a trend.
    const first = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const firstRun = await waitFor(
      () => service.get(first.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(first.id);
    expect(firstRun?.state).toBe("COMPLETED");

    let ledger = await service.healthLedger();
    expect(ledger.samples).toHaveLength(1);
    expect(ledger.trend).toBeUndefined();
    expect(ledger.maintenance).toBeUndefined();
    const sample = ledger.samples[0];
    expect(sample).toBeDefined();
    if (!sample) throw new Error("health sample was not persisted");
    // Structural metrics measured from the scope snapshot, change metrics from the verified diff.
    expect(sample.runId).toBe(first.id);
    expect(sample.projectId).toMatch(/^project-[a-f0-9]{64}$/u);
    expect(sample.projectId).not.toContain(fixture.path);
    expect(sample.evidenceBasis).toBe("VERIFIED_CANDIDATE");
    expect(sample.structuralBasis).toBe("BASE_REVISION");
    expect(sample.changeBasis).toBe("VERIFIED_CANDIDATE_DIFF");
    expect(sample.candidateId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(sample.candidateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(sample.revision).toMatch(/^[a-f0-9]{40}$/u);
    expect(sample.structural?.fileCount).toBeGreaterThan(0);
    expect(sample.structural?.parsedCoverage).toBeGreaterThanOrEqual(0);
    // The fixture agent writes agent-output.md; the recorded change metrics reflect that diff.
    expect(sample.change).toBeDefined();
    // DomainTelemetryRecorder implements listRecords, so the operational group is measured.
    expect(sample.operational?.taskCount).toBe(1);
    expect(sample.operational?.modelMix).toBeDefined();

    // A second run produces a second sample and therefore a trend and a maintenance decision.
    const second = await service.create({
      prompt: "Write the fixture artifact again",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    const secondRun = await waitFor(
      () => service.get(second.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(second.id);
    expect(secondRun?.state).toBe("COMPLETED");

    ledger = await service.healthLedger();
    expect(ledger.samples).toHaveLength(2);
    expect(ledger.trend).toBeDefined();
    expect(ledger.maintenance).toBeDefined();
    // Independent run bases do not establish ancestry, so structural direction remains unknown.
    expect(ledger.trend?.metrics.filter((metric) => metric.group === "structural")).toEqual(
      expect.arrayContaining([expect.objectContaining({ direction: "UNKNOWN" })]),
    );
    expect(ledger.maintenance?.needed).toBe(false);

    const failed = await service.create({
      prompt: "Write a different fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "missing-health-proof.txt" },
    });
    await service.waitForIdle(failed.id);
    expect((await service.get(failed.id))?.verificationState).toBe("QUARANTINED");
    ledger = await service.healthLedger();
    expect(ledger.samples).toHaveLength(2);
    expect(
      (await service.events(failed.id)).some((event) => event.type === "HealthSampleSkipped"),
    ).toBe(true);
  });
});
