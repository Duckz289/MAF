import { describe, expect, it } from "vitest";
import { ProviderCircuitBreaker } from "../src/domain/circuit-breaker";

const policy = { failureThreshold: 3, degradedThreshold: 1, cooldownMs: 1_000 };

describe("ProviderCircuitBreaker", () => {
  it("starts HEALTHY for an unknown provider", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    expect(breaker.state("acme")).toBe("HEALTHY");
    expect(breaker.canAttempt("acme")).toBe(true);
  });

  it("reports DEGRADED before the failure threshold is reached, but still allows attempts", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    breaker.recordOutcome("acme", false);
    expect(breaker.state("acme")).toBe("DEGRADED");
    expect(breaker.canAttempt("acme")).toBe(true);
  });

  it("opens the circuit at the failure threshold and refuses further attempts", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    breaker.recordOutcome("acme", false);
    breaker.recordOutcome("acme", false);
    breaker.recordOutcome("acme", false);
    expect(breaker.state("acme")).toBe("OPEN_CIRCUIT");
    expect(breaker.canAttempt("acme")).toBe(false);
  });

  it("stays OPEN_CIRCUIT and refuses attempts until the cooldown elapses", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    expect(breaker.canAttempt("acme", t0 + 500)).toBe(false);
    expect(breaker.state("acme", t0 + 500)).toBe("OPEN_CIRCUIT");
  });

  it("allows exactly one bounded probe once the cooldown elapses (HALF_OPEN)", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    const afterCooldown = t0 + policy.cooldownMs + 1;
    expect(breaker.state("acme", afterCooldown)).toBe("HALF_OPEN");
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(true);
    breaker.beginAttempt("acme", afterCooldown);
    // A second check while the probe is in flight must not allow a concurrent second attempt.
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(false);
  });

  it("closes the circuit on a successful HALF_OPEN probe", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    const afterCooldown = t0 + policy.cooldownMs + 1;
    breaker.beginAttempt("acme", afterCooldown);
    breaker.recordOutcome("acme", true, afterCooldown);
    expect(breaker.state("acme", afterCooldown)).toBe("HEALTHY");
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(true);
  });

  it("resets the cooldown clock on a failed HALF_OPEN probe rather than retrying immediately", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    const afterCooldown = t0 + policy.cooldownMs + 1;
    breaker.beginAttempt("acme", afterCooldown);
    breaker.recordOutcome("acme", false, afterCooldown);
    // Immediately after the failed probe, the circuit must be open again, not half-open.
    expect(breaker.state("acme", afterCooldown)).toBe("OPEN_CIRCUIT");
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(false);
    // Only after a FULL fresh cooldown from the failed probe does it go half-open again.
    expect(breaker.state("acme", afterCooldown + policy.cooldownMs + 1)).toBe("HALF_OPEN");
  });

  it("releases a HALF_OPEN probe slot via releaseProbe without affecting failure counters", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    const afterCooldown = t0 + policy.cooldownMs + 1;
    breaker.beginAttempt("acme", afterCooldown);
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(false);
    // Regression: if an attempt's outcome is not provider-health-relevant (e.g. the probe failed
    // for an agent-code reason, not a provider one), recordOutcome() is never called for it — but
    // the probe slot MUST still be released, or canAttempt() would refuse every future attempt
    // forever (a permanent, self-inflicted denial of service for this provider).
    breaker.releaseProbe("acme");
    expect(breaker.canAttempt("acme", afterCooldown)).toBe(true);
    // Failure counters are untouched by releaseProbe — still the same HALF_OPEN state, not reset.
    expect(breaker.state("acme", afterCooldown)).toBe("HALF_OPEN");
  });

  it("stays permanently open if a HALF_OPEN probe's outcome is never resolved at all", () => {
    // This documents the exact bug releaseProbe() fixes: without EITHER recordOutcome() or
    // releaseProbe() being called after beginAttempt(), the slot leaks forever.
    const breaker = new ProviderCircuitBreaker(policy);
    const t0 = 1_000_000;
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    breaker.recordOutcome("acme", false, t0);
    const afterCooldown = t0 + policy.cooldownMs + 1;
    breaker.beginAttempt("acme", afterCooldown);
    // No recordOutcome() or releaseProbe() call here — simulating the bug.
    const muchLater = afterCooldown + policy.cooldownMs * 100;
    expect(breaker.canAttempt("acme", muchLater)).toBe(false);
  });

  it("tracks providers independently", () => {
    const breaker = new ProviderCircuitBreaker(policy);
    breaker.recordOutcome("acme", false);
    breaker.recordOutcome("acme", false);
    breaker.recordOutcome("acme", false);
    expect(breaker.state("acme")).toBe("OPEN_CIRCUIT");
    expect(breaker.state("other")).toBe("HEALTHY");
    expect(breaker.canAttempt("other")).toBe(true);
  });
});
