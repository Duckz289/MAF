import type { ModeDecision } from "./mode-controller";
import {
  type AgentCapabilities,
  type ExecutionMode,
  type ModeEnforcementMethod,
  modeTransitionDirection,
} from "./types";

export interface EnforcementPolicy {
  /** Upper bound on policy-driven session restarts per run. */
  maxPolicyRestarts: number;
}

export const defaultEnforcementPolicy: EnforcementPolicy = {
  maxPolicyRestarts: 1,
};

export interface EnforcementContext {
  sessionActive: boolean;
  policyRestartsUsed: number;
}

export interface PendingModeEnforcement {
  decision: ModeDecision;
  fromEffective: ExecutionMode;
  method: Extract<ModeEnforcementMethod, "LIVE_UPDATE" | "SAFE_RESTART" | "DEFERRED_BOUNDARY">;
  requestId: string;
  requestedAt: string;
}

/**
 * Chooses how a desired mode change is enforced on execution. Deterministic:
 * - No active session: the change applies at the session boundary immediately.
 * - Live update when the agent genuinely supports mid-session policy updates.
 * - Safe restart only for broadening transitions (the constrained session cannot benefit from a
 *   broader policy it never learns about), only when supported, and only within the restart bound.
 * - Otherwise defer to the next safe execution boundary. Tightening transitions never restart a
 *   session: the session finishes its bounded attempt and the tighter policy applies at the
 *   boundary.
 */
export const planEnforcement = (
  decision: ModeDecision,
  fromEffective: ExecutionMode,
  capabilities: Pick<AgentCapabilities, "livePolicyUpdate" | "safeSessionRestart">,
  context: EnforcementContext,
  policy: EnforcementPolicy = defaultEnforcementPolicy,
): ModeEnforcementMethod => {
  if (!context.sessionActive) return "SESSION_BOUNDARY";
  if (capabilities.livePolicyUpdate) return "LIVE_UPDATE";
  if (
    capabilities.safeSessionRestart &&
    modeTransitionDirection(fromEffective, decision.to) === "BROADENING" &&
    context.policyRestartsUsed < policy.maxPolicyRestarts
  ) {
    return "SAFE_RESTART";
  }
  return "DEFERRED_BOUNDARY";
};
