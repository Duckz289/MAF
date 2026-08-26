import {
  type Event,
  type ExecutionMode,
  type ModeChangedData,
  type ModeEnforcementMethod,
  type Run,
  type RuntimeSignalSnapshot,
  type RuntimeSignals,
  signalValues,
} from "./types";

export interface ModeDecision {
  to: ExecutionMode;
  reason: string;
  evidence: Record<string, unknown>;
  signalSnapshotId?: string;
  evidenceIds?: string[];
}

export interface AdaptiveModePolicy {
  uncertaintyThreshold: number;
  dependencyExpansionThreshold: number;
  crossModuleEdgesThreshold: number;
  touchedModulesThreshold: number;
  verifierFailureThreshold: number;
  transitionCooldownObservations: number;
  strictSoloDependencyExpansionDelta: number;
  strictSoloCrossModuleEdgesDelta: number;
  strictSoloTouchedModulesDelta: number;
  strictSoloContextExpansionDelta: number;
}

export const defaultAdaptiveModePolicy: AdaptiveModePolicy = {
  uncertaintyThreshold: 0.7,
  dependencyExpansionThreshold: 3,
  crossModuleEdgesThreshold: 3,
  touchedModulesThreshold: 4,
  verifierFailureThreshold: 2,
  transitionCooldownObservations: 3,
  strictSoloDependencyExpansionDelta: 2,
  strictSoloCrossModuleEdgesDelta: 2,
  strictSoloTouchedModulesDelta: 2,
  strictSoloContextExpansionDelta: 3,
};

export interface ModeDecisionContext {
  lastTransitionSequence?: number;
  lastTransitionSnapshot?: RuntimeSignalSnapshot;
}

export class AdaptiveModeController {
  constructor(private readonly policy: AdaptiveModePolicy = defaultAdaptiveModePolicy) {}

  initial(requested?: ExecutionMode): ExecutionMode {
    return requested ?? "GUIDED";
  }

  decide(
    current: ExecutionMode,
    input: RuntimeSignals | RuntimeSignalSnapshot,
    context: ModeDecisionContext = {},
  ): ModeDecision | undefined {
    const snapshot =
      "runId" in input && "sequence" in input ? (input as RuntimeSignalSnapshot) : undefined;
    const signals: RuntimeSignals = snapshot ? signalValues(snapshot) : (input as RuntimeSignals);
    const uncertainty = signals.rootCauseUncertainty ?? 0;
    const expansion = signals.dependencyExpansion ?? 0;
    const crossEdges = signals.crossModuleEdges ?? 0;
    const modules = signals.touchedModules ?? 0;
    const failures = signals.repeatedVerifierFailures ?? 0;
    const baseline = context.lastTransitionSnapshot
      ? signalValues(context.lastTransitionSnapshot)
      : undefined;
    const delta = (name: keyof RuntimeSignals, currentValue: number): number =>
      Math.max(0, currentValue - Number(baseline?.[name] ?? 0));
    const deltas = {
      dependencyExpansion: delta("dependencyExpansion", expansion),
      crossModuleEdges: delta("crossModuleEdges", crossEdges),
      touchedModules: baseline ? delta("touchedModules", modules) : 0,
      contextExpansion: delta("contextExpansion", signals.contextExpansion ?? 0),
      verifierFailures: delta("repeatedVerifierFailures", failures),
      stabilizationInvalidations: delta(
        "stabilizationInvalidations",
        signals.stabilizationInvalidations ?? 0,
      ),
    };

    const inCooldown =
      snapshot !== undefined &&
      context.lastTransitionSequence !== undefined &&
      snapshot.sequence - context.lastTransitionSequence <
        this.policy.transitionCooldownObservations;

    if (current === "STRICT") {
      const uncertaintyIncreased =
        uncertainty >= this.policy.uncertaintyThreshold &&
        uncertainty > Number(baseline?.rootCauseUncertainty ?? 0);
      const reexpanded =
        deltas.dependencyExpansion > 0 ||
        deltas.crossModuleEdges > 0 ||
        deltas.touchedModules > 0 ||
        deltas.contextExpansion > 0 ||
        deltas.verifierFailures > 0 ||
        deltas.stabilizationInvalidations > 0 ||
        uncertaintyIncreased;
      if (!reexpanded) return undefined;

      const severe =
        deltas.dependencyExpansion >= this.policy.strictSoloDependencyExpansionDelta ||
        deltas.crossModuleEdges >= this.policy.strictSoloCrossModuleEdgesDelta ||
        deltas.touchedModules >= this.policy.strictSoloTouchedModulesDelta ||
        deltas.contextExpansion >= this.policy.strictSoloContextExpansionDelta ||
        deltas.verifierFailures >= this.policy.verifierFailureThreshold ||
        uncertaintyIncreased;
      return this.decision(snapshot, {
        to: severe ? "SOLO_NATIVE" : "GUIDED",
        reason: severe
          ? "Stabilized scope was invalidated by significant repository or verifier re-expansion"
          : "Stabilized scope was invalidated by a bounded unexpected expansion",
        evidence: this.evidence(snapshot, {
          ...deltas,
          uncertainty,
          scopeStabilized: signals.scopeStabilized ?? false,
        }),
      });
    }

    if (
      !inCooldown &&
      current === "GUIDED" &&
      (uncertainty >= this.policy.uncertaintyThreshold ||
        expansion >= this.policy.dependencyExpansionThreshold ||
        crossEdges >= this.policy.crossModuleEdgesThreshold ||
        modules >= this.policy.touchedModulesThreshold ||
        failures >= this.policy.verifierFailureThreshold)
    ) {
      return this.decision(snapshot, {
        to: "SOLO_NATIVE",
        reason:
          "Investigation requires coherent native reasoning across an expanding dependency surface",
        evidence: this.evidence(snapshot, {
          uncertainty,
          expansion,
          crossEdges,
          modules,
          failures,
        }),
      });
    }

    if (
      !inCooldown &&
      (current === "GUIDED" || current === "SOLO_NATIVE") &&
      signals.scopeStabilized === true &&
      signals.mechanicalRemainingWork === true
    ) {
      return this.decision(snapshot, {
        to: "STRICT",
        reason: "Scope is stable and the remaining work is deterministic",
        evidence: this.evidence(snapshot, {
          scopeStabilized: true,
          mechanicalRemainingWork: true,
          modules,
        }),
      });
    }

    return undefined;
  }

  /**
   * Enforces a decided transition on the run. This is the only place effective mode changes, and
   * it always records how the change was enforced. Desired mode follows because an enforced mode
   * is by definition also the desired one at enforcement time.
   */
  apply(
    run: Run,
    decision: ModeDecision,
    enforcement: { method: ModeEnforcementMethod; evidence: Record<string, unknown> },
    now = new Date().toISOString(),
  ): Event<ModeChangedData> {
    const from = run.effectiveMode;
    run.effectiveMode = decision.to;
    run.desiredMode = decision.to;
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
        enforcement,
        ...(decision.signalSnapshotId ? { signalSnapshotId: decision.signalSnapshotId } : {}),
        ...(decision.evidenceIds ? { evidenceIds: decision.evidenceIds } : {}),
      },
    };
  }

  private decision(
    snapshot: RuntimeSignalSnapshot | undefined,
    decision: Omit<ModeDecision, "signalSnapshotId" | "evidenceIds">,
  ): ModeDecision {
    if (!snapshot) return decision;
    return {
      ...decision,
      signalSnapshotId: snapshot.id,
      evidenceIds: [
        ...new Set(Object.values(snapshot.signals).flatMap((item) => item.evidenceIds)),
      ],
    };
  }

  private evidence(
    snapshot: RuntimeSignalSnapshot | undefined,
    fallback: Record<string, number | boolean>,
  ): Record<string, unknown> {
    if (!snapshot) return fallback;
    return {
      checkpoint: snapshot.checkpoint,
      sequence: snapshot.sequence,
      decision: fallback,
      signals: Object.fromEntries(
        Object.entries(snapshot.signals).map(([name, signal]) => [
          name,
          {
            value: signal.value,
            source: signal.source,
            provenance: signal.provenance,
            reliability: signal.reliability,
          },
        ]),
      ),
    };
  }
}
