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
  { type: "complete", data: { result: "done", subtype: "success" }, timestamp: timestamp() },
];

export const arrivedFailureScript = (): AgentEvent[] => [
  {
    type: "usage",
    data: { inputTokens: 80, outputTokens: 40, cachedTokens: 0, costUsd: 0.03 },
    timestamp: timestamp(),
  },
  {
    type: "complete",
    data: { result: "I could not fix this", subtype: "error_during_execution" },
    timestamp: timestamp(),
  },
];

export const providerErrorScript = (message = "ECONNRESET: socket hang up"): AgentEvent[] => [
  { type: "error", data: { message }, timestamp: timestamp() },
];

export const nonRetryableErrorScript = (): AgentEvent[] => [
  { type: "error", data: { message: "invalid api key: unauthorized" }, timestamp: timestamp() },
];
