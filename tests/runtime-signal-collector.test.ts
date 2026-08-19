import { describe, expect, it } from "vitest";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { RepositorySnapshot } from "../src/domain/ports";
import type { AgentEvent, RuntimeSignals, Verification } from "../src/domain/types";

const repository: RepositorySnapshot = {
  revision: "fixture",
  files: [
    "src/web/image.ts",
    "src/application/media.ts",
    "src/application/controller.ts",
    "src/infrastructure/resolver.ts",
    "src/domain/permissions.ts",
  ],
  symbols: [],
  relations: [
    { from: "src/web/image.ts", to: "src/application/media.ts", kind: "IMPORTS" },
    {
      from: "src/application/controller.ts",
      to: "src/application/media.ts",
      kind: "IMPORTS",
    },
    {
      from: "src/application/media.ts",
      to: "src/infrastructure/resolver.ts",
      kind: "IMPORTS",
    },
    {
      from: "src/infrastructure/resolver.ts",
      to: "src/domain/permissions.ts",
      kind: "IMPORTS",
    },
  ],
  moduleMap: {
    "src/web": ["src/web/image.ts"],
    "src/application": ["src/application/media.ts", "src/application/controller.ts"],
    "src/infrastructure": ["src/infrastructure/resolver.ts"],
    "src/domain": ["src/domain/permissions.ts"],
  },
  moduleOwnership: {
    "src/web/image.ts": "src/web",
    "src/application/media.ts": "src/application",
    "src/application/controller.ts": "src/application",
    "src/infrastructure/resolver.ts": "src/infrastructure",
    "src/domain/permissions.ts": "src/domain",
  },
  moduleRoots: [],
  evidence: [],
};

const timestamp = "2026-08-19T00:00:00.000Z";

const initialize = (
  collector: EvidenceRuntimeSignalCollector,
  runId = crypto.randomUUID(),
  externalHints?: RuntimeSignals,
) =>
  collector.observe({
    runId,
    type: "INITIAL_CONTEXT",
    checkpoint: "context-built",
    timestamp,
    repository,
    initialFiles: ["src/web/image.ts"],
    initialModules: ["src/web"],
    ...(externalHints ? { externalHints } : {}),
  });

const tool = (path: string, operation = "read_file"): AgentEvent => ({
  type: "tool",
  data: { tool: operation, operation, path },
  timestamp,
});

const observeTool = (
  collector: EvidenceRuntimeSignalCollector,
  runId: string,
  path: string,
  operation?: string,
) =>
  collector.observe({
    runId,
    type: "AGENT_EVENT",
    checkpoint: "agent-tool",
    timestamp,
    event: tool(path, operation),
  });

describe("EvidenceRuntimeSignalCollector", () => {
  it("derives touched modules, dependency expansion, and meaningful cross-module edges", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    await observeTool(collector, runId, "src/application/media.ts");
    await observeTool(collector, runId, "src/infrastructure/resolver.ts");
    const snapshot = await observeTool(collector, runId, "src/domain/permissions.ts");

    expect(snapshot.signals.touchedModules?.value).toBe(4);
    expect(snapshot.signals.dependencyExpansion?.value).toBe(3);
    expect(snapshot.signals.contextExpansion?.value).toBe(3);
    expect(snapshot.signals.crossModuleEdges?.value).toBe(3);
    expect(snapshot.signals.crossModuleEdges?.provenance).toBe("DETERMINISTIC");
    expect(snapshot.evidence.some((item) => Array.isArray(item.data.files))).toBe(true);
  });

  it("classifies stable scope from a configurable meaningful-event window", async () => {
    const collector = new EvidenceRuntimeSignalCollector({
      stabilizationWindow: 5,
      minimumMechanicalEdits: 2,
      maxMechanicalTargets: 3,
      maximumMechanicalUncertainty: 0.5,
    });
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    await observeTool(collector, runId, "src/application/media.ts");
    for (let index = 0; index < 4; index += 1)
      await observeTool(collector, runId, "src/application/media.ts", "edit_file");
    const snapshot = await observeTool(collector, runId, "src/application/media.ts", "edit_file");

    expect(snapshot.signals.scopeStabilized).toMatchObject({
      value: true,
      provenance: "HEURISTIC",
      reliability: "MEDIUM",
    });
    expect(snapshot.signals.mechanicalRemainingWork?.value).toBe(true);
  });

  it("does not stabilize while scope is still expanding", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    for (let index = 0; index < 4; index += 1)
      await observeTool(collector, runId, "src/web/image.ts", "edit_file");
    const snapshot = await observeTool(collector, runId, "src/application/media.ts", "edit_file");
    expect(snapshot.signals.scopeStabilized?.value).toBe(false);
  });

  it("does not claim stabilization before the full observation window", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    let snapshot = await observeTool(collector, runId, "src/web/image.ts", "edit_file");
    for (let index = 0; index < 3; index += 1)
      snapshot = await observeTool(collector, runId, "src/web/image.ts", "edit_file");
    expect(snapshot.signals.scopeStabilized?.value).toBe(false);
  });

  it("accumulates verifier failures only from trusted verification history", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId, { repeatedVerifierFailures: 99 });
    const failure = (id: string): Verification => ({
      id,
      runId,
      type: "command",
      state: "QUARANTINED",
      exitCode: 1,
      output: "failed",
      startedAt: timestamp,
      completedAt: timestamp,
    });
    await collector.observe({
      runId,
      type: "VERIFICATION",
      checkpoint: "verification-quarantined",
      timestamp,
      verification: failure("one"),
    });
    const snapshot = await collector.observe({
      runId,
      type: "VERIFICATION",
      checkpoint: "verification-quarantined",
      timestamp,
      verification: failure("two"),
    });
    expect(snapshot.signals.repeatedVerifierFailures).toMatchObject({
      value: 2,
      source: "verifier-history",
      provenance: "DETERMINISTIC",
    });
  });

  it("labels manual compatibility signals as external hints without overriding facts", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const snapshot = await initialize(collector, crypto.randomUUID(), {
      rootCauseUncertainty: 0.8,
      touchedModules: 99,
      scopeStabilized: true,
    });
    expect(snapshot.signals.rootCauseUncertainty).toMatchObject({
      value: 0.8,
      provenance: "EXTERNAL_HINT",
    });
    expect(snapshot.signals.scopeStabilized).toMatchObject({
      value: false,
      provenance: "HEURISTIC",
    });
    expect(snapshot.signals.touchedModules).toMatchObject({
      value: 1,
      provenance: "DETERMINISTIC",
    });
  });

  it("does not count imports inside one architectural module as cross-module edges", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await collector.observe({
      runId,
      type: "INITIAL_CONTEXT",
      checkpoint: "context-built",
      timestamp,
      repository,
      initialFiles: ["src/application/media.ts"],
      initialModules: ["src/application"],
    });
    const snapshot = await observeTool(collector, runId, "src/application/controller.ts");
    expect(snapshot.signals.touchedModules?.value).toBe(1);
    expect(snapshot.signals.crossModuleEdges?.value).toBe(0);
  });

  it("invalidates previously stable scope when a new module and dependency edge appear", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    for (let index = 0; index < 5; index += 1) {
      await observeTool(collector, runId, "src/web/image.ts", "edit_file");
    }
    expect((await collector.latest(runId))?.signals.scopeStabilized?.value).toBe(true);
    const invalidated = await observeTool(
      collector,
      runId,
      "src/application/media.ts",
      "read_file",
    );
    expect(invalidated.signals.scopeStabilized?.value).toBe(false);
    expect(invalidated.signals.mechanicalRemainingWork?.value).toBe(false);
    expect(invalidated.signals.stabilizationInvalidations?.value).toBe(1);
    expect(
      invalidated.evidence.some((item) => item.summary.includes("Previously stabilized scope")),
    ).toBe(true);
  });

  it("lets trusted verifier failure invalidate stabilization and block mechanical narrowing", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    for (let index = 0; index < 5; index += 1) {
      await observeTool(collector, runId, "src/web/image.ts", "edit_file");
    }
    const verification: Verification = {
      id: "failure",
      runId,
      type: "command",
      state: "QUARANTINED",
      exitCode: 1,
      output: "failed",
      startedAt: timestamp,
      completedAt: timestamp,
      attempt: 1,
      candidateId: "candidate",
    };
    const snapshot = await collector.observe({
      runId,
      type: "VERIFICATION",
      checkpoint: "verification-attempt-1-quarantined",
      timestamp,
      verification,
    });
    expect(snapshot.signals.scopeStabilized?.value).toBe(false);
    expect(snapshot.signals.mechanicalRemainingWork?.value).toBe(false);
  });

  it("does not let agent inference override contradictory repository expansion", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    const snapshot = await collector.observe({
      runId,
      type: "AGENT_EVENT",
      checkpoint: "agent-tool",
      timestamp,
      event: {
        type: "tool",
        data: {
          tool: "edit_file",
          operation: "edit_file",
          path: "src/application/media.ts",
          mechanicalRemainingWork: true,
        },
        timestamp,
      },
    });
    expect(snapshot.signals.scopeStabilized?.value).toBe(false);
    expect(snapshot.signals.mechanicalRemainingWork).toMatchObject({
      value: false,
      provenance: "HEURISTIC",
    });
  });
});
