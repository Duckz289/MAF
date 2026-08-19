import type { Event, ExecutionMode, ModeChangedData, Run, RuntimeSignals } from "./types";

export interface ModeDecision {
  to: ExecutionMode;
  reason: string;
  evidence: Record<string, number | string | boolean>;
}

export class AdaptiveModeController {
  initial(requested?: ExecutionMode): ExecutionMode {
    return requested ?? "GUIDED";
  }

  decide(current: ExecutionMode, signals: RuntimeSignals): ModeDecision | undefined {
    const uncertainty = signals.rootCauseUncertainty ?? 0;
    const expansion = signals.dependencyExpansion ?? 0;
    const crossEdges = signals.crossModuleEdges ?? 0;
    const modules = signals.touchedModules ?? 0;
    const failures = signals.repeatedVerifierFailures ?? 0;

    if (
      current === "GUIDED" &&
      (uncertainty >= 0.7 || expansion >= 3 || crossEdges >= 4 || modules >= 4 || failures >= 2)
    ) {
      return {
        to: "SOLO_NATIVE",
        reason:
          "Investigation requires coherent native reasoning across an expanding dependency surface",
        evidence: { uncertainty, expansion, crossEdges, modules, failures },
      };
    }

    if (
      (current === "GUIDED" || current === "SOLO_NATIVE") &&
      signals.scopeStabilized === true &&
      signals.mechanicalRemainingWork === true
    ) {
      return {
        to: "STRICT",
        reason: "Scope is stable and the remaining work is deterministic",
        evidence: { scopeStabilized: true, mechanicalRemainingWork: true, modules },
      };
    }

    return undefined;
  }

  apply(run: Run, decision: ModeDecision, now = new Date().toISOString()): Event<ModeChangedData> {
    const from = run.executionMode;
    run.executionMode = decision.to;
    run.updatedAt = now;
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      type: "ModeChanged",
      timestamp: now,
      data: {
        from,
        to: decision.to,
        reason: decision.reason,
        evidence: decision.evidence,
      },
    };
  }
}
