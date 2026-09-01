import { describe, expect, it } from "vitest";
import {
  classifyAttemptOutcome,
  isAutoRetryableAttempt,
  type AttemptTerminalEvidence,
} from "../evaluation/experiments/real/lib/session-outcome";
import { classifyFailure, isAutoRetryable } from "../src/domain/recovery";
import type { StderrDiagnostics } from "../evaluation/experiments/real/lib/diagnostics";

const noStderr: StderrDiagnostics = {
  observed: false,
  totalChars: 0,
  truncated: false,
  summary: null,
  tail: null,
};

const stderrWith = (text: string): StderrDiagnostics => ({
  observed: true,
  totalChars: text.length,
  truncated: false,
  summary: text.split("\n")[0] ?? null,
  tail: text,
});

const evidence = (overrides: Partial<AttemptTerminalEvidence> = {}): AttemptTerminalEvidence => ({
  timedOut: false,
  cancelled: false,
  adapterErrorMessage: null,
  structuredResultObserved: false,
  resultSubtype: null,
  resultIsError: null,
  exitCode: null,
  terminationSignal: null,
  stderr: noStderr,
  ...overrides,
});

describe("retry amplification regression (proven Finding 1)", () => {
  it("does NOT auto-retry a bare nonzero exit with no proven cause", () => {
    const outcome = classifyAttemptOutcome(evidence({ exitCode: 1 }));
    expect(outcome.classification).toBe("CLI_PROCESS_FAILURE");
    expect(outcome.autoRetryable).toBe(false);
    expect(outcome.executionStatus).toBe("INFRA_FAILURE");
    // The whole point: it must explain what failed, not restate the exit code as if it were a cause.
    expect(outcome.firstFailure).toMatch(/no terminal result/i);
  });

  it("documents that the OLD synthesized-string path would have auto-retried the same failure", () => {
    // This is the exact composition that turned an authorized 2-execution preflight into 3 spawns:
    // agent-session-runner synthesized this string, recovery.ts pattern-matched it to AGENT_FAILURE,
    // and isAutoRetryable treats AGENT_FAILURE as retryable. Asserted here so the regression is
    // pinned to a test rather than a comment -- and so it is explicit that recovery.ts itself was
    // never the bug (its behavior is correct for the genuine agent messages it was built for).
    const legacyMessage = "agent process exited with code 1";
    expect(classifyFailure(new Error(legacyMessage))).toBe("AGENT_FAILURE");
    expect(isAutoRetryable("AGENT_FAILURE")).toBe(true);
    // The repaired path never produces that string and never reaches that classifier.
    expect(classifyAttemptOutcome(evidence({ exitCode: 1 })).autoRetryable).toBe(false);
  });

  it("still auto-retries a genuine provider failure, so the treatment is not disabled", () => {
    const outcome = classifyAttemptOutcome(
      evidence({ exitCode: 1, stderr: stderrWith("API error: 529 overloaded_error") }),
    );
    expect(outcome.classification).toBe("PROVIDER_FAILURE");
    expect(outcome.autoRetryable).toBe(true);
  });

  it("treats PROVIDER_FAILURE as the only auto-retryable class", () => {
    expect(isAutoRetryableAttempt("PROVIDER_FAILURE")).toBe(true);
    for (const other of [
      "COMPLETED",
      "PARTICIPANT_TASK_FAILURE",
      "AUTH_CONFIGURATION_FAILURE",
      "CLI_PROCESS_FAILURE",
      "TIMEOUT",
      "CANCELLED",
      "INFRASTRUCTURE_FAILURE",
    ] as const) {
      expect(isAutoRetryableAttempt(other)).toBe(false);
    }
  });

  it("never auto-retries an auth failure, which a retry could not fix", () => {
    const outcome = classifyAttemptOutcome(
      evidence({ exitCode: 1, stderr: stderrWith("Authentication failed: not logged in") }),
    );
    expect(outcome.classification).toBe("AUTH_CONFIGURATION_FAILURE");
    expect(outcome.autoRetryable).toBe(false);
  });
});

describe("terminal-state precedence (proven Finding 2)", () => {
  it("keeps a structured success COMPLETED despite a later nonzero exit, and flags the discrepancy", () => {
    const outcome = classifyAttemptOutcome(
      evidence({
        structuredResultObserved: true,
        resultSubtype: "success",
        resultIsError: false,
        exitCode: 1,
      }),
    );
    expect(outcome.classification).toBe("COMPLETED");
    expect(outcome.executionStatus).toBe("COMPLETED");
    expect(outcome.exitCodeDiscrepancy).toBe(true);
  });

  it("does not mark an ERROR result COMPLETED merely because it had type=result", () => {
    const outcome = classifyAttemptOutcome(
      evidence({
        structuredResultObserved: true,
        resultSubtype: "error_during_execution",
        resultIsError: true,
        exitCode: 1,
      }),
    );
    expect(outcome.classification).toBe("CLI_PROCESS_FAILURE");
    expect(outcome.executionStatus).toBe("INFRA_FAILURE");
    expect(outcome.autoRetryable).toBe(false);
  });

  it("classifies a participant's own limit as a VALID run with a non-DVS outcome", () => {
    const outcome = classifyAttemptOutcome(
      evidence({
        structuredResultObserved: true,
        resultSubtype: "error_max_turns",
        resultIsError: true,
        exitCode: 1,
      }),
    );
    expect(outcome.classification).toBe("PARTICIPANT_TASK_FAILURE");
    // Protocol 17.1: an arm's own failure is a valid run, never rerun, never removed from the
    // valid-run denominator.
    expect(outcome.executionStatus).toBe("COMPLETED");
    expect(outcome.autoRetryable).toBe(false);
  });

  it("ranks a controller timeout above any participant-reported evidence", () => {
    const outcome = classifyAttemptOutcome(
      evidence({ timedOut: true, structuredResultObserved: true, resultSubtype: "success" }),
    );
    expect(outcome.classification).toBe("TIMEOUT");
    expect(outcome.executionStatus).toBe("TIMEOUT");
  });

  it("ranks an explicit cancellation above a timeout", () => {
    const outcome = classifyAttemptOutcome(evidence({ cancelled: true, timedOut: true }));
    expect(outcome.classification).toBe("CANCELLED");
    expect(outcome.executionStatus).toBe("CANCELLED");
  });

  it("keeps signal termination distinguishable from exit(1)", () => {
    const outcome = classifyAttemptOutcome(
      evidence({ exitCode: null, terminationSignal: "SIGKILL" }),
    );
    expect(outcome.classification).toBe("CLI_PROCESS_FAILURE");
    expect(outcome.firstFailure).toMatch(/SIGKILL/u);
    expect(outcome.autoRetryable).toBe(false);
  });

  it("reports a spawn/transport failure as INFRASTRUCTURE_FAILURE, not a participant fault", () => {
    const outcome = classifyAttemptOutcome(
      evidence({ adapterErrorMessage: "spawn claude ENOENT" }),
    );
    expect(outcome.classification).toBe("INFRASTRUCTURE_FAILURE");
    expect(outcome.autoRetryable).toBe(false);
    expect(outcome.firstFailure).toMatch(/ENOENT/u);
  });

  it("records the evidence trail that produced each decision", () => {
    const outcome = classifyAttemptOutcome(evidence({ exitCode: 1 }));
    expect(outcome.evidence.length).toBeGreaterThan(0);
    expect(outcome.evidence.join(" ")).toMatch(/no structured terminal result/i);
  });
});
