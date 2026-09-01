import type { AgentAdapter, AgentSession, AgentStartInput } from "../../src/domain/ports";
import type { AgentCapabilities, AgentEvent } from "../../src/domain/types";

export type FakeAgentScript = AgentEvent[] | "HANG";

/**
 * A controllable AgentAdapter test double implementing the same port ClaudeCodeAdapter implements,
 * so executor tests can exercise NativeExperimentExecutor/MafExperimentExecutor's own orchestration
 * logic (timeout handling, retry, mode-transition recording, provenance assembly) without spawning
 * any process or calling any provider.
 *
 * `scripts` is consumed in order, one per `events()` call (i.e. one per session actually driven to
 * completion by runAgentSession) -- the Nth call to events() replays scripts[N]. "HANG" never
 * resolves, so the caller's own timeout is what ends the session, exactly like a real runaway CLI
 * process would only be ended by the controller's timeout + cancel().
 */
export class FakeAgentAdapter implements AgentAdapter {
  readonly name = "fake-agent";
  readonly startedInputs: AgentStartInput[] = [];
  readonly cancelledSessionIds: string[] = [];
  private callIndex = 0;

  constructor(private readonly scripts: FakeAgentScript[]) {}

  async capabilities(): Promise<AgentCapabilities> {
    return {
      repoSearch: true,
      fileRead: true,
      fileWrite: true,
      shell: true,
      browser: false,
      mcp: false,
      nativePlanning: true,
      nativeSubagents: false,
      contextManagement: true,
      streaming: true,
      resumeSession: false,
      livePolicyUpdate: false,
      safeSessionRestart: false,
      oauthAuth: true,
      apiKeyAuth: true,
      extensions: {},
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    this.startedInputs.push(input);
    return { id: crypto.randomUUID() };
  }

  async send(): Promise<void> {
    // The script is fixed at construction time; nothing to do with the message itself.
  }

  async *events(_session: AgentSession): AsyncIterable<AgentEvent> {
    const index = this.callIndex;
    this.callIndex += 1;
    const script = this.scripts[index];
    if (script === undefined) {
      throw new Error(`FakeAgentAdapter has no script queued for call ${index}`);
    }
    if (script === "HANG") {
      await new Promise<void>(() => {
        // Never resolves; the caller's own timeout must end this.
      });
      return;
    }
    for (const event of script) yield event;
  }

  async cancel(session: AgentSession): Promise<void> {
    this.cancelledSessionIds.push(session.id);
  }

  async resume(): Promise<AgentSession> {
    throw new Error("FakeAgentAdapter does not support resume");
  }
}

const timestamp = () => new Date().toISOString();

export const successScript = (overrides: Partial<Record<string, unknown>> = {}): AgentEvent[] => [
  {
    type: "usage",
    data: {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      costUsd: 0.05,
      resolvedModel: "claude-sonnet-5-20250929",
      ...overrides,
    },
    timestamp: timestamp(),
  },
  {
    type: "complete",
    data: { result: "done", subtype: "success", isError: false },
    timestamp: timestamp(),
  },
];

/** Structured success whose cost was never reported. Must stay UNKNOWN, never become 0. */
export const successUnknownCostScript = (): AgentEvent[] => [
  {
    type: "usage",
    data: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: null },
    timestamp: timestamp(),
  },
  {
    type: "complete",
    data: { result: "done", subtype: "success", isError: false },
    timestamp: timestamp(),
  },
];

/** The participant's own limit: a VALID run with a non-DVS outcome, never rerun. */
export const participantLimitScript = (): AgentEvent[] => [
  {
    type: "usage",
    data: { inputTokens: 80, outputTokens: 40, cachedTokens: 0, costUsd: 0.03 },
    timestamp: timestamp(),
  },
  {
    type: "complete",
    data: { result: "hit turn limit", subtype: "error_max_turns", isError: true },
    timestamp: timestamp(),
  },
];

/**
 * A bare nonzero process exit with no structured result and no diagnostic stderr -- the exact shape
 * that caused the first billed preflight's authorization overrun. Must classify CLI_PROCESS_FAILURE
 * and must NOT be auto-retryable.
 */
export const bareNonzeroExitScript = (exitCode = 1): AgentEvent[] => [
  { type: "error", data: { exitCode, terminationSignal: null }, timestamp: timestamp() },
];

/** Signal termination: exitCode is null and must never be coerced to 1. */
export const signalTerminationScript = (signal = "SIGKILL"): AgentEvent[] => [
  { type: "error", data: { exitCode: null, terminationSignal: signal }, timestamp: timestamp() },
];

/** Provider/upstream failure evidenced on stderr -- the one auto-retryable class. */
export const providerFailureScript = (
  stderrText = "API error: 529 overloaded_error, service unavailable",
): AgentEvent[] => [
  { type: "tool", data: { stream: "stderr", text: stderrText }, timestamp: timestamp() },
  { type: "error", data: { exitCode: 1, terminationSignal: null }, timestamp: timestamp() },
];

/** Auth/configuration failure evidenced on stderr. Never auto-retryable. */
export const authFailureScript = (): AgentEvent[] => [
  {
    type: "tool",
    data: {
      stream: "stderr",
      text: "Authentication failed: not logged in. Please run `claude auth login`.",
    },
    timestamp: timestamp(),
  },
  { type: "error", data: { exitCode: 1, terminationSignal: null }, timestamp: timestamp() },
];

/** A structured SUCCESS result followed by an unrelated nonzero exit. */
export const successThenNonzeroExitScript = (): AgentEvent[] => [
  ...successScript(),
  { type: "error", data: { exitCode: 1, terminationSignal: null }, timestamp: timestamp() },
];

/** A provider failure that also reports a cost, for cumulative-budget tests. */
export const costedProviderFailureScript = (costUsd: number): AgentEvent[] => [
  {
    type: "usage",
    data: { inputTokens: 50, outputTokens: 25, cachedTokens: 0, costUsd },
    timestamp: timestamp(),
  },
  {
    type: "tool",
    data: { stream: "stderr", text: "API error: 529 overloaded_error" },
    timestamp: timestamp(),
  },
  { type: "error", data: { exitCode: 1, terminationSignal: null }, timestamp: timestamp() },
];

/** A provider failure whose cost was never observed, for the fail-closed retry test. */
export const uncostedProviderFailureScript = (): AgentEvent[] => [
  {
    type: "tool",
    data: { stream: "stderr", text: "API error: 529 overloaded_error" },
    timestamp: timestamp(),
  },
  { type: "error", data: { exitCode: 1, terminationSignal: null }, timestamp: timestamp() },
];
