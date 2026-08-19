import {
  signalValues,
  type Event,
  type ExecutionMode,
  type ModeChangedData,
  type Run,
  type RuntimeSignals,
  type RuntimeSignalSnapshot,
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
}

export const defaultAdaptiveModePolicy: AdaptiveModePolicy = {
  uncertaintyThreshold: 0.7,
  dependencyExpansionThreshold: 3,
  crossModuleEdgesThreshold: 3,
  touchedModulesThreshold: 4,
  verifierFailureThreshold: 2,
  transitionCooldownObservations: 3,
};

export interface ModeDecisionContext {
  lastTransitionSequence?: number;
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
    if (current === "STRICT") return undefined;
    const snapshot =
      "runId" in input && "sequence" in input ? (input as RuntimeSignalSnapshot) : undefined;
    const signals: RuntimeSignals = snapshot ? signalValues(snapshot) : (input as RuntimeSignals);
    const uncertainty = signals.rootCauseUncertainty ?? 0;
    const expansion = signals.dependencyExpansion ?? 0;
    const crossEdges = signals.crossModuleEdges ?? 0;
    const modules = signals.touchedModules ?? 0;
    const failures = signals.repeatedVerifierFailures ?? 0;

    const inCooldown =
      snapshot !== undefined &&
      context.lastTransitionSequence !== undefined &&
      snapshot.sequence - context.lastTransitionSequence <
        this.policy.transitionCooldownObservations;

    if (
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
