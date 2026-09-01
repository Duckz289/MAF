// Drives one AgentAdapter session (real ClaudeCodeAdapter, or a fake test double behind the same
// port) to completion or to the frozen 1,800,000ms timeout, whichever comes first.
//
// This is the one place both the Native and MAF executors call to actually run a participant, so the
// timeout classification (COMPLETED / TIMEOUT / CANCELLED / INFRA_FAILURE) and usage/cost extraction
// happen exactly once and identically for both arms.

import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import type { AgentEvent } from "../../../../src/domain/types";

export type AgentSessionStatus = "COMPLETED" | "TIMEOUT" | "CANCELLED" | "INFRA_FAILURE";

export interface AgentSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AgentSessionResult {
  status: AgentSessionStatus;
  events: AgentEvent[];
  usage: AgentSessionUsage;
  reportedCost: number | null;
  resolvedModel: string | null;
  resultText: string | null;
  /** The CLI's own structured terminal classification, when reported. Self-reported, untrusted. */
  resultSubtype: string | null;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunAgentSessionParams {
  adapter: AgentAdapter;
  input: AgentStartInput;
  prompt: string;
  timeoutMs: number;
  /** Invoked for every streamed event, in order, before this function returns. Used by the MAF
   *  executor to feed its runtime signal collector and mode controller in real time. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/** Sentinel resolved by the timeout timer so Promise.race can distinguish it from a real outcome. */
const TIMEOUT_MARKER = Symbol("agent-session-timeout");

export const runAgentSession = async (
  params: RunAgentSessionParams,
): Promise<AgentSessionResult> => {
  const startedAt = new Date().toISOString();
  const session = await params.adapter.start(params.input);
  await params.adapter.send(session, params.prompt);

  const events: AgentEvent[] = [];
  let usage: AgentSessionUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let reportedCost: number | null = null;
  let resolvedModel: string | null = null;
  let resultText: string | null = null;
  let resultSubtype: string | null = null;
  let errorMessage: string | undefined;

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
        resolvedModel =
          typeof event.data.resolvedModel === "string" ? event.data.resolvedModel : null;
      }
      if (event.type === "error") {
        const exitCode = event.data.exitCode;
        errorMessage =
          typeof event.data.message === "string"
            ? event.data.message
            : exitCode !== undefined
              ? `agent process exited with code ${String(exitCode)}`
              : "agent reported an unspecified error";
      }
      if (event.type === "complete") {
        if (typeof event.data.result === "string") resultText = event.data.result;
        if (typeof event.data.subtype === "string") resultSubtype = event.data.subtype;
      }
      if (params.onEvent) await params.onEvent(event);
    }
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_MARKER), params.timeoutMs);
  });

  const outcome = await Promise.race([drain().then(() => "DRAINED" as const), timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  const finishedAt = new Date().toISOString();
  if (outcome === TIMEOUT_MARKER) {
    await params.adapter.cancel(session).catch(() => undefined);
    return {
      status: "TIMEOUT",
      events,
      usage,
      reportedCost,
      resolvedModel,
      resultText,
      resultSubtype,
      errorMessage: `participant exceeded the ${params.timeoutMs}ms timeout`,
      startedAt,
      finishedAt,
    };
  }

  const hasComplete = events.some((event) => event.type === "complete");
  const status: AgentSessionStatus = hasComplete && !errorMessage ? "COMPLETED" : "INFRA_FAILURE";
  return {
    status,
    events,
    usage,
    reportedCost,
    resolvedModel,
    resultText,
    resultSubtype,
    ...(errorMessage ? { errorMessage } : {}),
    startedAt,
    finishedAt,
  };
};
