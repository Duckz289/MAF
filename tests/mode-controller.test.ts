import { describe, expect, it } from "vitest";
import { AdaptiveModeController } from "../src/domain/mode-controller";
import { emptyCost, emptyUsage, type Run, type RuntimeSignalSnapshot } from "../src/domain/types";

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

  it("prevents rapid reversal and treats STRICT as a terminal narrowing mode", () => {
    const controller = new AdaptiveModeController();
    const snapshot: RuntimeSignalSnapshot = {
      id: "snapshot",
      runId: "run",
      sequence: 4,
      checkpoint: "agent-tool",
      timestamp: "2026-08-19T00:00:00.000Z",
      signals: {
        scopeStabilized: {
          value: true,
          source: "scope-stability-policy",
          provenance: "HEURISTIC",
          reliability: "MEDIUM",
          evidenceIds: ["scope"],
          timestamp: "2026-08-19T00:00:00.000Z",
        },
        mechanicalRemainingWork: {
          value: true,
          source: "mechanical-work-policy",
          provenance: "HEURISTIC",
          reliability: "MEDIUM",
          evidenceIds: ["mechanical"],
          timestamp: "2026-08-19T00:00:00.000Z",
        },
      },
      evidence: [],
    };
    expect(
      controller.decide("SOLO_NATIVE", snapshot, { lastTransitionSequence: 3 }),
    ).toBeUndefined();
    expect(controller.decide("STRICT", { dependencyExpansion: 20 })).toBeUndefined();
  });
});
