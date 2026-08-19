import { describe, expect, it } from "vitest";
import { AdaptiveModeController } from "../src/domain/mode-controller";
import {
  emptyCost,
  emptyUsage,
  type Run,
  type RuntimeSignals,
  type RuntimeSignalSnapshot,
  type RuntimeSignalValues,
} from "../src/domain/types";

const run = (): Run => ({
  id: "run-1",
  taskId: "task-1",
  state: "RUNNING",
  executionMode: "GUIDED",
  verificationState: "PROPOSED",
  agent: "fixture",
  model: "native",
  provider: "native",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  changedFiles: [],
  cost: emptyCost(),
  usage: emptyUsage(),
  retryCount: 0,
});

const observed = (sequence: number, values: RuntimeSignals): RuntimeSignalSnapshot => ({
  id: `snapshot-${sequence}`,
  runId: "run",
  sequence,
  checkpoint: "agent-tool",
  timestamp: "2026-08-19T00:00:00.000Z",
  signals: Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        value,
        source: typeof value === "boolean" ? "scope-stability-policy" : "repository-observation",
        provenance: typeof value === "boolean" ? "HEURISTIC" : "DETERMINISTIC",
        reliability: typeof value === "boolean" ? "MEDIUM" : "HIGH",
        evidenceIds: [`evidence-${name}`],
        timestamp: "2026-08-19T00:00:00.000Z",
      },
    ]),
  ) as RuntimeSignalValues,
  evidence: [],
});

describe("AdaptiveModeController", () => {
  it("defaults unknown tasks to GUIDED", () => {
    expect(new AdaptiveModeController().initial()).toBe("GUIDED");
  });

  it("promotes coupled investigation to SOLO_NATIVE with evidence", () => {
    const controller = new AdaptiveModeController();
    const decision = controller.decide("GUIDED", {
      rootCauseUncertainty: 0.9,
      crossModuleEdges: 6,
    });
    expect(decision?.to).toBe("SOLO_NATIVE");
    if (!decision) throw new Error("Expected a mode decision");
    const event = controller.apply(run(), decision);
    expect(event.type).toBe("ModeChanged");
    expect(event.data.reason).toContain("coherent native reasoning");
    expect(event.data.evidence).toMatchObject({ uncertainty: 0.9, crossEdges: 6 });
  });

  it("narrows stabilized work to STRICT", () => {
    const decision = new AdaptiveModeController().decide("SOLO_NATIVE", {
      scopeStabilized: true,
      mechanicalRemainingWork: true,
    });
    expect(decision?.to).toBe("STRICT");
  });

  it("prevents narrowing during the transition cooldown", () => {
    const controller = new AdaptiveModeController();
    const snapshot = observed(4, {
      scopeStabilized: true,
      mechanicalRemainingWork: true,
    });
    expect(
      controller.decide("SOLO_NATIVE", snapshot, { lastTransitionSequence: 3 }),
    ).toBeUndefined();
  });

  it("keeps STRICT during ordinary stable bounded work", () => {
    const controller = new AdaptiveModeController();
    const baseline = observed(10, {
      dependencyExpansion: 3,
      crossModuleEdges: 3,
      touchedModules: 4,
      contextExpansion: 3,
      scopeStabilized: true,
      mechanicalRemainingWork: true,
      stabilizationInvalidations: 0,
    });
    expect(
      controller.decide(
        "STRICT",
        observed(11, {
          dependencyExpansion: 3,
          crossModuleEdges: 3,
          touchedModules: 4,
          contextExpansion: 3,
          scopeStabilized: true,
          mechanicalRemainingWork: true,
          stabilizationInvalidations: 0,
        }),
        { lastTransitionSequence: 10, lastTransitionSnapshot: baseline },
      ),
    ).toBeUndefined();
  });

  it("re-expands STRICT to GUIDED for a small unexpected scope delta", () => {
    const controller = new AdaptiveModeController();
    const baseline = observed(10, {
      dependencyExpansion: 3,
      crossModuleEdges: 3,
      touchedModules: 4,
      contextExpansion: 3,
      stabilizationInvalidations: 0,
    });
    const decision = controller.decide(
      "STRICT",
      observed(11, {
        dependencyExpansion: 4,
        crossModuleEdges: 3,
        touchedModules: 5,
        contextExpansion: 4,
        scopeStabilized: false,
        stabilizationInvalidations: 1,
      }),
      { lastTransitionSequence: 10, lastTransitionSnapshot: baseline },
    );
    expect(decision?.to).toBe("GUIDED");
    expect(decision?.reason).toContain("bounded unexpected expansion");
  });

  it("re-expands STRICT to SOLO_NATIVE for a large coupled delta", () => {
    const controller = new AdaptiveModeController();
    const baseline = observed(10, {
      dependencyExpansion: 1,
      crossModuleEdges: 1,
      touchedModules: 2,
      contextExpansion: 1,
    });
    const decision = controller.decide(
      "STRICT",
      observed(11, {
        dependencyExpansion: 3,
        crossModuleEdges: 3,
        touchedModules: 4,
        contextExpansion: 4,
        scopeStabilized: false,
        stabilizationInvalidations: 1,
      }),
      { lastTransitionSequence: 10, lastTransitionSnapshot: baseline },
    );
    expect(decision?.to).toBe("SOLO_NATIVE");
    expect(decision?.reason).toContain("significant");
  });

  it("does not immediately narrow after leaving STRICT", () => {
    const controller = new AdaptiveModeController();
    const reexpanded = observed(11, {
      dependencyExpansion: 2,
      crossModuleEdges: 2,
      touchedModules: 3,
      contextExpansion: 2,
      scopeStabilized: false,
      stabilizationInvalidations: 1,
    });
    expect(
      controller.decide(
        "GUIDED",
        observed(12, { scopeStabilized: true, mechanicalRemainingWork: true }),
        { lastTransitionSequence: 11, lastTransitionSnapshot: reexpanded },
      ),
    ).toBeUndefined();
  });
});
