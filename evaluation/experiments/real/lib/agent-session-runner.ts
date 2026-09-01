// Drives one AgentAdapter attempt (real ClaudeCodeAdapter, or a fake test double behind the same
// port) to a terminal state, bounded by a controller-owned deadline.
//
// This is the one place both the Native and MAF executors call to run a participant, so terminal
// classification, diagnostics capture and usage/cost extraction happen exactly once and identically
// for both arms.
//
// Repaired after the first billed Protocol v2 preflight (INVALID_PREFLIGHT_ATTEMPT). Previously this
// module (a) collapsed terminal state to `hasComplete && !errorMessage ? COMPLETED : INFRA_FAILURE`,
// so a real structured success was erased by any later nonzero exit and an ERROR result was
// indistinguishable from a success one, and (b) synthesized the string
// "agent process exited with code N", which src/domain/recovery.ts then pattern-matched into a
// RETRYABLE AGENT_FAILURE -- turning an authorized 2-execution preflight into 3 real spawns.
// Classification now lives in session-outcome.ts and works from structured evidence only.

import { ClaudeCodeAdapter } from "../../../../src/infrastructure/claude-code-adapter";
import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import type { AgentEvent } from "../../../../src/domain/types";
import { summarizeStderr, type StderrDiagnostics } from "./diagnostics";
import {
  classifyAttemptOutcome,
  type AttemptOutcome,
  type AttemptTerminalEvidence,
} from "./session-outcome";

export interface AgentSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AgentSessionResult {
  outcome: AttemptOutcome;
  events: AgentEvent[];
  usage: AgentSessionUsage;
  /** Null means no usage/cost event was ever observed. Never coerced to 0. */
  reportedCost: number | null;
  /** Exactly what the provider reported as its model, if anything. Classified downstream. */
  reportedModel: string | null;
  resultText: string | null;
  resultSubtype: string | null;
  resultIsError: boolean | null;
  exitCode: number | null;
  terminationSignal: string | null;
  stderr: StderrDiagnostics;
  /** The executable + argv actually spawned, when the adapter can report it. */
  spawn: { command: string; args: string[] } | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface RunAgentSessionParams {
  adapter: AgentAdapter;
  input: AgentStartInput;
  prompt: string;
  /** Deadline for THIS attempt. The caller derives it from the remaining run deadline. */
  timeoutMs: number;
  /** Invoked for every streamed event, in order, before this function returns. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/** Sentinel resolved by the timeout timer so Promise.race can distinguish it from a real outcome. */
const TIMEOUT_MARKER = Symbol("agent-session-timeout");

export const runAgentSession = async (
  params: RunAgentSessionParams,
): Promise<AgentSessionResult> => {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const session = await params.adapter.start(params.input);
  await params.adapter.send(session, params.prompt);

  // Captured immediately after send(): ClaudeCodeAdapter releases the session once its event stream
  // is fully drained, so asking afterwards would return undefined.
  const spawn =
    params.adapter instanceof ClaudeCodeAdapter
      ? (params.adapter.spawnRecord(session) ?? null)
      : null;

  const events: AgentEvent[] = [];
  const stderrChunks: string[] = [];
  let usage: AgentSessionUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let reportedCost: number | null = null;
  let reportedModel: string | null = null;
  let resultText: string | null = null;
  let resultSubtype: string | null = null;
  let resultIsError: boolean | null = null;
  let structuredResultObserved = false;
  let adapterErrorMessage: string | null = null;
  let exitCode: number | null = null;
  let terminationSignal: string | null = null;

  const drain = async (): Promise<void> => {
    for await (const event of params.adapter.events(session)) {
      events.push(event);
      if (event.type === "usage") {
        usage = {
          inputTokens: Number(event.data.inputTokens ?? 0),
          outputTokens: Number(event.data.outputTokens ?? 0),
          cachedTokens: Number(event.data.cachedTokens ?? 0),
        };
        reportedCost = typeof event.data.costUsd === "number" ? event.data.costUsd : null;
        reportedModel =
          typeof event.data.resolvedModel === "string" ? event.data.resolvedModel : null;
      }
      if (event.type === "tool" && event.data.stream === "stderr") {
        if (typeof event.data.text === "string") stderrChunks.push(event.data.text);
      }
      if (event.type === "error") {
        // Process-end evidence and transport-error evidence arrive on the same event type but are
        // different facts. Keep them separate: an exit code is not an error message, and a null
        // exit code (signal termination) is not exit(1).
        if (typeof event.data.message === "string") adapterErrorMessage = event.data.message;
        if (typeof event.data.exitCode === "number") exitCode = event.data.exitCode;
        if (typeof event.data.terminationSignal === "string") {
          terminationSignal = event.data.terminationSignal;
        }
      }
      if (event.type === "complete") {
        structuredResultObserved = true;
        if (typeof event.data.result === "string") resultText = event.data.result;
        if (typeof event.data.subtype === "string") resultSubtype = event.data.subtype;
        if (typeof event.data.isError === "boolean") resultIsError = event.data.isError;
      }
      if (params.onEvent) await params.onEvent(event);
    }
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_MARKER), params.timeoutMs);
  });

  const raced = await Promise.race([drain().then(() => "DRAINED" as const), timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const timedOut = raced === TIMEOUT_MARKER;
  if (timedOut) await params.adapter.cancel(session).catch(() => undefined);

  const finishedAt = new Date().toISOString();
  const stderr = summarizeStderr(stderrChunks);
  const evidence: AttemptTerminalEvidence = {
    timedOut,
    cancelled: false,
    adapterErrorMessage,
    structuredResultObserved,
    resultSubtype,
    resultIsError,
    exitCode,
    terminationSignal,
    stderr,
  };

  return {
    outcome: classifyAttemptOutcome(evidence),
    events,
    usage,
    reportedCost,
    reportedModel,
    resultText,
    resultSubtype,
    resultIsError,
    exitCode,
    terminationSignal,
    stderr,
    spawn,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
};
