// Terminal-state precedence and failure classification for one real participant attempt.
//
// Two proven defects from the first billed Protocol v2 preflight are fixed here.
//
// DEFECT A (retry amplification). `agent-session-runner.ts` synthesized the human-readable string
// "agent process exited with code N" and the MAF executor fed it to src/domain/recovery.ts
// classifyFailure, whose pattern /agent (?:process|session) (?:exited|closed|crashed)/ maps it to
// AGENT_FAILURE -- which isAutoRetryable treats as retryable. Every generic nonzero CLI exit
// therefore auto-retried, silently turning an authorized 2-execution preflight into 3 real
// subprocess spawns. The bug was never in recovery.ts (whose behavior is correct for the genuine
// agent error messages it was designed for); it was in round-tripping a SYNTHESIZED string through
// a text matcher. This module classifies from STRUCTURED EVIDENCE instead -- exit code, terminating
// signal, the CLI's own result subtype/is_error, and stderr shape -- and never produces a
// human-readable string that some downstream matcher could re-interpret.
//
// DEFECT B (terminal state collapse). The runner computed
//     hasComplete && !errorMessage ? COMPLETED : INFRA_FAILURE
// The adapter emits usage+complete the moment it parses a `result` line, and SEPARATELY emits an
// error event whenever the process later exits nonzero. So a genuine structured success was erased
// by any later nonzero exit, and (in the other direction) nothing distinguished an ERROR result
// subtype from a success one -- both merely had type "result". The precedence table below states
// exactly how the two independent evidence channels (protocol-terminal vs process-terminal) combine.

import type { StderrDiagnostics } from "./diagnostics";

/**
 * Why an attempt ended. Distinguished at the granularity the mission requires, so retry policy can
 * be driven by what actually happened rather than by string shape.
 *
 * COMPLETED                  the participant's turn reached a structured successful terminal result.
 * PARTICIPANT_TASK_FAILURE   the participant itself failed the task in a way it reported
 *                            structurally (e.g. it exhausted its own turn limit). This is the
 *                            participant's own outcome: a VALID run with a non-DVS result, and per
 *                            EXPERIMENT_PROTOCOL.md section 17.1 it is NEVER rerun.
 * PROVIDER_FAILURE           the provider/upstream failed (rate limit, overload, network). The one
 *                            class the frozen MAF treatment policy intends to be auto-retryable.
 * AUTH_CONFIGURATION_FAILURE credentials/config are wrong. Retrying cannot fix it and would just
 *                            spend another authorized invocation on a guaranteed failure.
 * CLI_PROCESS_FAILURE        the CLI process failed without proving a task-level or provider cause
 *                            -- a bare nonzero exit, a signal, a malformed stream. NOT retryable:
 *                            this is exactly the shape that caused the authorization overrun.
 * TIMEOUT                    the controller's own deadline stopped it.
 * CANCELLED                  the controller cancelled it deliberately.
 * INFRASTRUCTURE_FAILURE     harness-side failure (spawn failed, workspace unusable).
 */
export type AttemptFailureClass =
  | "COMPLETED"
  | "PARTICIPANT_TASK_FAILURE"
  | "PROVIDER_FAILURE"
  | "AUTH_CONFIGURATION_FAILURE"
  | "CLI_PROCESS_FAILURE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INFRASTRUCTURE_FAILURE";

/** Maps an attempt classification onto the frozen BenchmarkExecution.executionStatus vocabulary. */
export type BenchmarkExecutionStatus =
  | "COMPLETED"
  | "INFRA_FAILURE"
  | "TIMEOUT"
  | "CANCELLED"
  | "QUOTA_EXHAUSTED";

/**
 * The ONLY class the frozen MAF treatment policy auto-retries.
 *
 * EXPERIMENT_PROTOCOL.md / native-vs-maf-v1.json treatmentPolicy.recoveryBehavior reads:
 * "classifyFailure-driven provider-transient handling only". Provider-transient means PROVIDER
 * failures -- not "any process that exited nonzero". A participant task failure is deliberately
 * excluded (protocol 17.1: an arm's own failure is never rerun, because rerunning until an arm
 * succeeds biases its DVS rate upward). Auth/CLI/signal failures are excluded because a retry
 * cannot fix them and would only consume another billed invocation.
 */
export const isAutoRetryableAttempt = (classification: AttemptFailureClass): boolean =>
  classification === "PROVIDER_FAILURE";

export const benchmarkStatusFor = (
  classification: AttemptFailureClass,
): BenchmarkExecutionStatus => {
  switch (classification) {
    case "COMPLETED":
      // The participant ran to a structured terminal result. Whether the CANDIDATE is any good is
      // never decided here -- only the controller-side independent verifier decides that.
      return "COMPLETED";
    case "PARTICIPANT_TASK_FAILURE":
      // Deliberately COMPLETED: the run is VALID with a non-DVS outcome (protocol 17.1). Marking it
      // INFRA_FAILURE would wrongly remove a real arm failure from the valid-run denominator.
      return "COMPLETED";
    case "TIMEOUT":
      return "TIMEOUT";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "INFRA_FAILURE";
  }
};

/** Result subtypes the Claude Code CLI reports that are unambiguously the participant's own limit. */
const participantTaskFailureSubtypes = new Set(["error_max_turns", "error_max_tokens"]);

/** stderr shapes that prove an auth/configuration cause. Word-anchored: a task's own output could
 *  contain these words incidentally, so the patterns require the failure phrasing, not the topic. */
const authFailurePatterns: RegExp[] = [
  /\b(?:invalid|missing|expired|revoked)\b[^\n]{0,40}\b(?:api[ _-]?key|token|credential)/iu,
  /\bnot\s+logged\s+in\b/iu,
  /\bauthentication\s+(?:failed|required|error)\b/iu,
  /\bunauthorized\b/iu,
  /\b401\b|\b403\b/u,
  /\bplease\s+run\s+["'`]?claude\s+(?:auth\s+)?login/iu,
];

/** stderr shapes that prove a provider/upstream cause -- the one auto-retryable class. */
const providerFailurePatterns: RegExp[] = [
  /\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b|\b429\b/iu,
  /\b(?:overloaded|service unavailable|bad gateway|gateway timeout)\b|\b50[0234]\b|\b529\b/iu,
  /\beconnreset\b|\beconnrefused\b|\betimedout\b|\beai_again\b|\benotfound\b/iu,
  /\bfetch failed\b|\bsocket hang up\b|\bnetwork (?:error|failure|unreachable)\b/iu,
];

export interface AttemptTerminalEvidence {
  /** The controller's own deadline fired. Highest-precedence harness fact. */
  timedOut: boolean;
  /** The controller cancelled deliberately (not a timeout). */
  cancelled: boolean;
  /** Adapter-level spawn/transport error message, when the adapter reported one. */
  adapterErrorMessage: string | null;
  /** True once a structured `result` terminal line was parsed from the stream. */
  structuredResultObserved: boolean;
  /** The CLI's own terminal subtype, e.g. "success" / "error_max_turns". */
  resultSubtype: string | null;
  /** The CLI's own `is_error` flag, when present. */
  resultIsError: boolean | null;
  /** Process exit code. Null when the process was terminated by a signal instead. */
  exitCode: number | null;
  /** Terminating signal name, when the runtime reported one. Never conflated with exitCode. */
  terminationSignal: string | null;
  stderr: StderrDiagnostics;
}

export interface AttemptOutcome {
  classification: AttemptFailureClass;
  executionStatus: BenchmarkExecutionStatus;
  autoRetryable: boolean;
  /** Structured, machine-readable statement of WHAT FIRST FAILED. Never a bare exit-code string. */
  firstFailure: string;
  /** Ordered evidence the decision was made from, for audit. */
  evidence: string[];
  /** True when a structured success result coexisted with a nonzero process exit. Recorded loudly:
   *  the structured result wins (it is the protocol-terminal statement), but the disagreement is
   *  real and a reader must be able to see it. */
  exitCodeDiscrepancy: boolean;
}

const describeProcessEnd = (evidence: AttemptTerminalEvidence): string => {
  if (evidence.terminationSignal !== null) {
    return `process terminated by signal ${evidence.terminationSignal}`;
  }
  if (evidence.exitCode === null) return "process end was not observed";
  return `process exited with code ${evidence.exitCode}`;
};

/**
 * The terminal-state precedence table. Evaluated strictly top to bottom; the first matching rule
 * wins and later evidence can only be RECORDED, never silently override it.
 *
 *  1. CANCELLED                  controller cancelled -- a harness fact, outranks everything.
 *  2. TIMEOUT                    controller deadline fired -- a harness fact.
 *  3. INFRASTRUCTURE_FAILURE     adapter reported a spawn/transport error and no structured result
 *                                was ever parsed (the process never really ran).
 *  4. structured result present:
 *     4a. success + not is_error -> COMPLETED. A later nonzero exit does NOT erase it; the
 *                                   disagreement is recorded as exitCodeDiscrepancy.
 *     4b. known participant-limit subtype -> PARTICIPANT_TASK_FAILURE (valid run, never rerun).
 *     4c. any other error subtype / is_error -> classified from stderr, defaulting to
 *                                   CLI_PROCESS_FAILURE (fail closed: not retryable) because an
 *                                   unrecognized error result does not PROVE a retryable cause.
 *  5. no structured result:      classified from stderr shape, then signal, then exit code --
 *                                defaulting to CLI_PROCESS_FAILURE. This is the rule that stops the
 *                                retry amplification: a bare nonzero exit proves nothing about
 *                                cause and is therefore never auto-retryable.
 */
export const classifyAttemptOutcome = (evidence: AttemptTerminalEvidence): AttemptOutcome => {
  const trail: string[] = [];
  const stderrText = [evidence.stderr.summary, evidence.stderr.tail]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const matchesAuth = authFailurePatterns.some((pattern) => pattern.test(stderrText));
  const matchesProvider = providerFailurePatterns.some((pattern) => pattern.test(stderrText));

  const finish = (
    classification: AttemptFailureClass,
    firstFailure: string,
    exitCodeDiscrepancy = false,
  ): AttemptOutcome => ({
    classification,
    executionStatus: benchmarkStatusFor(classification),
    autoRetryable: isAutoRetryableAttempt(classification),
    firstFailure,
    evidence: trail,
    exitCodeDiscrepancy,
  });

  // 1 / 2: harness facts outrank every participant-reported or process-reported signal.
  if (evidence.cancelled) {
    trail.push("controller cancelled the attempt");
    return finish("CANCELLED", "the controller cancelled this attempt");
  }
  if (evidence.timedOut) {
    trail.push("controller deadline fired before the participant produced a terminal result");
    return finish("TIMEOUT", "the participant exceeded the controller-owned run deadline");
  }

  // 3: the process never really ran.
  if (evidence.adapterErrorMessage !== null && !evidence.structuredResultObserved) {
    trail.push(`adapter reported a transport/spawn error: ${evidence.adapterErrorMessage}`);
    if (matchesAuth) {
      return finish(
        "AUTH_CONFIGURATION_FAILURE",
        `the participant process failed on authentication/configuration: ${evidence.adapterErrorMessage}`,
      );
    }
    if (matchesProvider) {
      return finish(
        "PROVIDER_FAILURE",
        `the participant process failed on a provider/network condition: ${evidence.adapterErrorMessage}`,
      );
    }
    return finish(
      "INFRASTRUCTURE_FAILURE",
      `the participant process could not be run: ${evidence.adapterErrorMessage}`,
    );
  }

  // 4: a structured terminal result exists. It is the protocol-terminal statement.
  if (evidence.structuredResultObserved) {
    const subtype = evidence.resultSubtype;
    trail.push(
      `structured terminal result observed (subtype=${subtype ?? "none"}, is_error=${
        evidence.resultIsError === null ? "absent" : String(evidence.resultIsError)
      })`,
    );
    const isErrorResult =
      evidence.resultIsError === true || (subtype !== null && subtype !== "success");

    if (!isErrorResult && (subtype === "success" || subtype === null)) {
      // 4a. Success. A later nonzero exit is recorded, not obeyed.
      const nonzeroExit =
        evidence.terminationSignal !== null ||
        (evidence.exitCode !== null && evidence.exitCode !== 0);
      if (nonzeroExit) {
        trail.push(
          `${describeProcessEnd(evidence)} AFTER a successful structured result; the structured ` +
            "result is the protocol-terminal statement and is not erased by the later process exit",
        );
      }
      return finish(
        "COMPLETED",
        "the participant reported a successful structured terminal result",
        nonzeroExit,
      );
    }

    if (subtype !== null && participantTaskFailureSubtypes.has(subtype)) {
      // 4b. The participant's own limit. A valid run with a non-DVS outcome; never rerun.
      trail.push(`subtype ${subtype} is a participant-own limit, not an infrastructure fault`);
      return finish(
        "PARTICIPANT_TASK_FAILURE",
        `the participant terminated on its own limit (${subtype}); this is the arm's own outcome, not an infrastructure failure`,
      );
    }

    // 4c. An error result whose cause is not proven task-level. Fail closed.
    if (matchesAuth) {
      trail.push("stderr matched an authentication/configuration failure shape");
      return finish(
        "AUTH_CONFIGURATION_FAILURE",
        `the participant returned an error result (${subtype ?? "is_error"}) with authentication/configuration evidence in stderr`,
      );
    }
    if (matchesProvider) {
      trail.push("stderr matched a provider/upstream failure shape");
      return finish(
        "PROVIDER_FAILURE",
        `the participant returned an error result (${subtype ?? "is_error"}) with provider/upstream evidence in stderr`,
      );
    }
    trail.push(
      "error result subtype is not a recognized participant limit and stderr proves no provider " +
        "cause; failing closed to a non-retryable CLI/process failure",
    );
    return finish(
      "CLI_PROCESS_FAILURE",
      `the participant returned an error result (${subtype ?? "is_error"}) with no proven task-level or provider cause`,
    );
  }

  // 5: no structured terminal result at all.
  trail.push("no structured terminal result was ever parsed from the participant stream");
  if (matchesAuth) {
    trail.push("stderr matched an authentication/configuration failure shape");
    return finish(
      "AUTH_CONFIGURATION_FAILURE",
      `the participant produced no terminal result and failed on authentication/configuration (${describeProcessEnd(evidence)})`,
    );
  }
  if (matchesProvider) {
    trail.push("stderr matched a provider/upstream failure shape");
    return finish(
      "PROVIDER_FAILURE",
      `the participant produced no terminal result and failed on a provider/upstream condition (${describeProcessEnd(evidence)})`,
    );
  }
  if (evidence.terminationSignal !== null) {
    trail.push("process was terminated by a signal, which proves no cause on its own");
    return finish(
      "CLI_PROCESS_FAILURE",
      `the participant process was terminated by signal ${evidence.terminationSignal} before producing a terminal result`,
    );
  }
  trail.push(
    "bare nonzero exit with no structured result and no proven cause; NOT auto-retryable (this is " +
      "the shape that caused the first billed preflight's authorization overrun)",
  );
  return finish(
    "CLI_PROCESS_FAILURE",
    `the participant process produced no terminal result and ${describeProcessEnd(evidence)}; cause unproven`,
  );
};
