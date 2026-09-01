import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../domain/ports";
import type { AgentCapabilities, AgentEvent, AgentSecurityBoundary } from "../domain/types";

interface ClaudeSession extends AgentSession {
  input: AgentStartInput;
  child?: ChildProcessWithoutNullStreams;
  queue: AgentEvent[];
  waiters: Array<() => void>;
  ended: boolean;
  /** Resolved model identifier observed on a streamed assistant message, if the CLI reported one. */
  resolvedModel?: string;
  /** The executable actually handed to spawn(), for provenance. */
  spawnedCommand?: string;
  /** The exact argument vector actually handed to spawn(), for provenance. */
  spawnedArgs?: string[];
}

/** What a session actually spawned. Absent until `send()` has run. */
export interface ClaudeCodeSpawnRecord {
  command: string;
  args: string[];
}

/** Effort levels the Claude Code CLI's `--effort` flag accepts. */
export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const claudeCodeEfforts: readonly ClaudeCodeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ClaudeCodeConfig {
  command?: string;
  model?: string;
  /**
   * Reasoning effort for the session, forwarded as the CLI's `--effort` argument.
   *
   * The first billed Protocol v2 preflight recorded `effort: "high"` in its provenance while never
   * emitting the argument at all, so both arms actually ran at the CLI's own default. A protocol
   * that declares effort a controlled variable has to send it, not merely claim it.
   */
  effort?: ClaudeCodeEffort;
  maxBudgetUsd?: number;
  permissionMode?: "acceptEdits" | "dontAsk" | "plan";
  /**
   * Fixed sentence prepended to every prompt ahead of `initialContext`. Defaults to the historical
   * MAF framing text below. Callers that need a participant to receive no MAF framing at all (e.g.
   * a true native-baseline benchmark arm) may pass an empty string; the default is unchanged for
   * every other caller.
   */
  promptPreamble?: string;
}

const DEFAULT_PROMPT_PREAMBLE =
  "MAF provides the following starting context. Keep your native planning and repository search.";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(private readonly config: ClaudeCodeConfig = {}) {}

  async capabilities(): Promise<AgentCapabilities> {
    return {
      repoSearch: true,
      fileRead: true,
      fileWrite: true,
      shell: true,
      browser: false,
      mcp: true,
      nativePlanning: true,
      nativeSubagents: true,
      contextManagement: true,
      streaming: true,
      resumeSession: false,
      livePolicyUpdate: false,
      safeSessionRestart: false,
      oauthAuth: true,
      apiKeyAuth: true,
      extensions: { claudeStreamJson: true },
    };
  }

  async securityBoundary(): Promise<AgentSecurityBoundary> {
    return {
      credentialCapability: "REFERENCE_ONLY",
      environmentAllowlist: true,
      processIsolation: false,
      networkIsolation: false,
      notes: [
        "Claude Code owns its native authentication session",
        "MAF does not inject managed provider secrets into the subprocess",
        "LocalWorktree mode does not provide OS or network isolation",
      ],
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const session: ClaudeSession = {
      id: crypto.randomUUID(),
      input,
      queue: [],
      waiters: [],
      ended: false,
    };
    this.sessions.set(session.id, session);
    return { id: session.id };
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const active = this.requireSession(session.id);
    if (active.child) throw new Error("Claude Code prompt is already running");
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      this.config.permissionMode ?? "acceptEdits",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.effort ? ["--effort", this.config.effort] : []),
      ...(this.config.maxBudgetUsd !== undefined
        ? ["--max-budget-usd", String(this.config.maxBudgetUsd)]
        : []),
    ];
    const requestedCommand = this.config.command ?? "claude";
    // Testability-only hook: a `.mjs`/`.cjs`/`.js` command is a fake CLI script, not a native
    // executable. `spawn(..., {shell: false})` cannot run one portably (Windows in particular
    // cannot execute a script file directly without a shell, which this adapter deliberately never
    // enables), so run it through the current Node binary instead. `claude` and any other real
    // executable are spawned exactly as before.
    const isScriptCommand = /\.(?:mjs|cjs|js)$/iu.test(requestedCommand);
    const spawnCommand = isScriptCommand ? process.execPath : requestedCommand;
    const spawnArgs = isScriptCommand ? [requestedCommand, ...args] : args;
    // Recorded so a caller can prove WHICH executable and WHICH arguments actually ran. The first
    // billed preflight could not establish either after the fact.
    active.spawnedCommand = spawnCommand;
    active.spawnedArgs = [...spawnArgs];
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: active.input.workspacePath,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        HARNESS_RUN_ID: active.input.run.id,
        HARNESS_MODE: active.input.run.effectiveMode,
      },
    });
    active.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.consume(active, line));
    child.once("error", (error) =>
      this.push(active, {
        type: "error",
        data: { message: error.message },
        timestamp: new Date().toISOString(),
      }),
    );
    child.stderr.on("data", (chunk) =>
      this.push(active, {
        type: "tool",
        data: { stream: "stderr", text: chunk.toString().slice(0, 8_000) },
        timestamp: new Date().toISOString(),
      }),
    );
    child.on("close", (code, signal) => {
      active.ended = true;
      // A signal-terminated process reports code === null. Coercing that to 1 (as this did before)
      // made a killed process indistinguishable from a genuine exit(1) in every downstream record,
      // destroying the single most useful discriminator when diagnosing a failed run. Both facts are
      // now reported separately, and neither is invented when absent.
      if (code !== 0 || signal !== null) {
        this.push(active, {
          type: "error",
          data: {
            exitCode: code,
            terminationSignal: signal,
          },
          timestamp: new Date().toISOString(),
        });
      }
      this.wake(active);
    });
    const preamble = this.config.promptPreamble ?? DEFAULT_PROMPT_PREAMBLE;
    const prompt = [preamble, active.input.initialContext, "Task:", message]
      .filter((part) => part.length > 0)
      .join("\n\n");
    child.stdin.end(prompt);
  }

  async *events(session: AgentSession): AsyncIterable<AgentEvent> {
    const active = this.requireSession(session.id);
    while (!active.ended || active.queue.length > 0) {
      const event = active.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => active.waiters.push(resolve));
    }
    this.sessions.delete(active.id);
  }

  async cancel(session: AgentSession): Promise<void> {
    this.requireSession(session.id).child?.kill("SIGTERM");
  }

  /**
   * What this session actually spawned. Returns undefined before `send()` has run, or once the
   * session has been drained and released. Exposed so an experiment controller can record the
   * executable and argument vector that really ran rather than the one it intended to run.
   */
  spawnRecord(session: AgentSession): ClaudeCodeSpawnRecord | undefined {
    const active = this.sessions.get(session.id);
    if (!active?.spawnedCommand || !active.spawnedArgs) return undefined;
    return { command: active.spawnedCommand, args: [...active.spawnedArgs] };
  }

  async resume(): Promise<AgentSession> {
    throw new Error("Claude Code resume is disabled for non-persistent MAF benchmark sessions");
  }

  private consume(session: ClaudeSession, line: string): void {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const timestamp = new Date().toISOString();
      if (payload.type === "assistant") {
        const message = payload.message as
          | { content?: Array<Record<string, unknown>>; model?: unknown }
          | undefined;
        // The Claude Code CLI echoes the underlying Anthropic Messages API response for each
        // assistant turn, which carries the concrete resolved model identifier (e.g. a dated
        // snapshot id) on `message.model`. Capturing it here is the only way this adapter can ever
        // report anything more specific than the requested alias; if the CLI never includes it, the
        // resolved model stays unknown rather than being invented.
        if (typeof message?.model === "string" && message.model.length > 0) {
          session.resolvedModel = message.model;
        }
        for (const content of message?.content ?? []) {
          if (content.type === "text")
            this.push(session, { type: "message", data: { text: content.text }, timestamp });
          if (content.type === "tool_use")
            this.push(session, {
              type: "tool",
              data: {
                tool: content.name,
                ...((content.input as Record<string, unknown> | undefined) ?? {}),
              },
              timestamp,
            });
        }
        return;
      }
      if (payload.type === "result") {
        const usage = (payload.usage as Record<string, unknown> | undefined) ?? {};
        this.push(session, {
          type: "usage",
          data: {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cachedTokens: Number(usage.cache_read_input_tokens ?? 0),
            costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : null,
            ...(session.resolvedModel ? { resolvedModel: session.resolvedModel } : {}),
          },
          timestamp,
        });
        this.push(session, {
          type: "complete",
          data: {
            result: payload.result,
            nativeSessionId: payload.session_id,
            // The CLI's own error flag on the terminal result. Without it, an ERROR result and a
            // SUCCESS result were indistinguishable to callers (both merely had type "result"),
            // which is half of the terminal-state collapse the first billed preflight exposed.
            ...(typeof payload.is_error === "boolean" ? { isError: payload.is_error } : {}),
            // The CLI's own structured terminal classification (e.g. "success",
            // "error_max_turns", "error_during_execution"), when it reports one. This is still
            // self-reported evidence -- the CLI's own claim about its own turn, not independent
            // verification -- but it is a structured field rather than a free-text heuristic, so
            // callers that need a self-reported completion signal should read this instead of
            // pattern-matching `result` text.
            ...(typeof payload.subtype === "string" ? { subtype: payload.subtype } : {}),
          },
          timestamp,
        });
        return;
      }
      this.push(session, { type: "tool", data: { nativeEventType: payload.type }, timestamp });
    } catch {
      this.push(session, {
        type: "message",
        data: { text: line },
        timestamp: new Date().toISOString(),
      });
    }
  }

  private push(session: ClaudeSession, event: AgentEvent): void {
    session.queue.push(event);
    this.wake(session);
  }

  private wake(session: ClaudeSession): void {
    for (const waiter of session.waiters.splice(0)) waiter();
  }

  private requireSession(id: string): ClaudeSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown Claude Code session: ${id}`);
    return session;
  }
}
