import { describe, expect, it } from "vitest";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { RepositorySnapshot } from "../src/domain/ports";
import type { AgentEvent, RuntimeSignals, Verification } from "../src/domain/types";

const repository: RepositorySnapshot = {
  revision: "fixture",
  files: ["frontend/image.ts", "api/media.ts", "storage/resolver.ts", "auth/permissions.ts"],
  symbols: [],
  relations: [
    { from: "frontend/image.ts", to: "api/media.ts", kind: "IMPORTS" },
    { from: "api/media.ts", to: "storage/resolver.ts", kind: "IMPORTS" },
    { from: "storage/resolver.ts", to: "auth/permissions.ts", kind: "IMPORTS" },
  ],
  moduleMap: {
    frontend: ["frontend/image.ts"],
    api: ["api/media.ts"],
    storage: ["storage/resolver.ts"],
    auth: ["auth/permissions.ts"],
  },
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
    initialFiles: ["frontend/image.ts"],
    initialModules: ["frontend"],
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
    await observeTool(collector, runId, "api/media.ts");
    await observeTool(collector, runId, "storage/resolver.ts");
    const snapshot = await observeTool(collector, runId, "auth/permissions.ts");

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
    });
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    await observeTool(collector, runId, "api/media.ts");
    for (let index = 0; index < 4; index += 1)
      await observeTool(collector, runId, "api/media.ts", "edit_file");
    const snapshot = await observeTool(collector, runId, "api/media.ts", "edit_file");

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
      await observeTool(collector, runId, "frontend/image.ts", "edit_file");
    const snapshot = await observeTool(collector, runId, "api/media.ts", "edit_file");
    expect(snapshot.signals.scopeStabilized?.value).toBe(false);
  });

  it("does not claim stabilization before the full observation window", async () => {
    const collector = new EvidenceRuntimeSignalCollector();
    const runId = crypto.randomUUID();
    await initialize(collector, runId);
    let snapshot = await observeTool(collector, runId, "frontend/image.ts", "edit_file");
    for (let index = 0; index < 3; index += 1)
      snapshot = await observeTool(collector, runId, "frontend/image.ts", "edit_file");
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
    expect(snapshot.signals.scopeStabilized?.provenance).toBe("EXTERNAL_HINT");
    expect(snapshot.signals.touchedModules).toMatchObject({
      value: 1,
      provenance: "DETERMINISTIC",
    });
  });
});
