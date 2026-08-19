/**
 * Deterministic, bounded provider health tracking — separate from model quality. No model is ever
 * consulted to judge provider health; this is threshold-and-cooldown arithmetic only, so a
 * provider that is obviously failing stops being retried instead of being called again and again.
 *
 * Contract for callers: check `canAttempt()` before starting an attempt; if the state is
 * HALF_OPEN, call `beginAttempt()` immediately before actually making the call, to consume the
 * single bounded probe slot; then, once the attempt finishes, call EITHER `recordOutcome()` (the
 * outcome is provider-health-relevant) OR `releaseProbe()` (it is not — e.g. the failure was
 * agent-code-quality, not provider/network). One of the two MUST be called every time, or a
 * HALF_OPEN probe slot consumed by `beginAttempt()` never gets released, permanently wedging the
 * circuit open for that provider (every future call sees `halfOpenTrialInFlight: true` forever).
 */
/** Thrown when an attempt is refused because a provider's circuit is currently open. */
export class ProviderCircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCircuitOpenError";
  }
}

export type ProviderCircuitState = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "HALF_OPEN";

export interface CircuitBreakerPolicy {
  /** Consecutive failures before the circuit opens (fast-fails every attempt). */
  failureThreshold: number;
  /** Consecutive failures before DEGRADED is reported (still attempts, just flagged). */
  degradedThreshold: number;
  /** How long an open circuit waits before allowing one HALF_OPEN trial attempt. */
  cooldownMs: number;
}

export const defaultCircuitBreakerPolicy: CircuitBreakerPolicy = {
  failureThreshold: 3,
  degradedThreshold: 1,
  cooldownMs: 30_000,
};

interface ProviderRecord {
  consecutiveFailures: number;
  openedAt?: number | undefined;
  halfOpenTrialInFlight: boolean;
}

/** Per-provider circuit breaker state, bounded and in-memory. */
export class ProviderCircuitBreaker {
  private readonly providers = new Map<string, ProviderRecord>();

  constructor(private readonly policy: CircuitBreakerPolicy = defaultCircuitBreakerPolicy) {
    if (policy.failureThreshold < 1) throw new Error("failureThreshold must be at least 1");
    if (policy.degradedThreshold < 1) throw new Error("degradedThreshold must be at least 1");
    if (policy.cooldownMs < 0) throw new Error("cooldownMs cannot be negative");
  }

  /** Whether a new attempt against this provider should even be started. */
  canAttempt(provider: string, now: number = Date.now()): boolean {
    const state = this.state(provider, now);
    if (state === "OPEN_CIRCUIT") return false;
    if (state === "HALF_OPEN") {
      const record = this.providers.get(provider);
      return record !== undefined && !record.halfOpenTrialInFlight;
    }
    return true;
  }

  state(provider: string, now: number = Date.now()): ProviderCircuitState {
    const record = this.providers.get(provider);
    if (!record) return "HEALTHY";
    if (record.consecutiveFailures < this.policy.failureThreshold) {
      return record.consecutiveFailures >= this.policy.degradedThreshold ? "DEGRADED" : "HEALTHY";
    }
    if (record.openedAt !== undefined && now - record.openedAt >= this.policy.cooldownMs) {
      return "HALF_OPEN";
    }
    return "OPEN_CIRCUIT";
  }

  /** Marks a HALF_OPEN trial as started, consuming the single bounded probe slot. */
  beginAttempt(provider: string, now: number = Date.now()): void {
    if (this.state(provider, now) !== "HALF_OPEN") return;
    const record = this.providers.get(provider);
    if (record) record.halfOpenTrialInFlight = true;
  }

  /**
   * Releases a HALF_OPEN probe slot without affecting failure counters or the cooldown clock —
   * for when an attempt's outcome isn't provider-health-relevant (e.g. an agent-code failure
   * during the probe). Without this, a probe whose outcome is never recorded via
   * `recordOutcome()` would leave `halfOpenTrialInFlight` permanently true.
   */
  releaseProbe(provider: string): void {
    const record = this.providers.get(provider);
    if (record) record.halfOpenTrialInFlight = false;
  }

  recordOutcome(provider: string, ok: boolean, now: number = Date.now()): void {
    if (ok) {
      this.providers.set(provider, { consecutiveFailures: 0, halfOpenTrialInFlight: false });
      return;
    }
    const record = this.providers.get(provider) ?? {
      consecutiveFailures: 0,
      halfOpenTrialInFlight: false,
    };
    const consecutiveFailures = record.consecutiveFailures + 1;
    const opening = consecutiveFailures >= this.policy.failureThreshold;
    // Any failure while at or above threshold (including a failed HALF_OPEN probe) resets the
    // cooldown clock to now, so a repeatedly-failing provider always waits a fresh cooldown
    // before its next probe rather than being retried immediately.
    this.providers.set(provider, {
      consecutiveFailures,
      halfOpenTrialInFlight: false,
      openedAt: opening ? now : undefined,
    });
  }
}
