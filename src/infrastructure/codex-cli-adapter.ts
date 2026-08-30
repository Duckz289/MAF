import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../domain/ports";
import type { AgentCapabilities, AgentEvent, AgentSecurityBoundary } from "../domain/types";

interface CodexSession extends AgentSession {
  input: AgentStartInput;
  child?: ChildProcessWithoutNullStreams;
  queue: AgentEvent[];
  waiters: Array<() => void>;
  ended: boolean;
}

export interface CodexCliConfig {
  command?: string;
  model?: string;
}

/**
 * Uses the officially authenticated Codex CLI. It deliberately delegates browser login and token
 * storage to Codex; MAF receives neither a ChatGPT cookie nor a Codex refresh token.
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly name = "codex-cli";
  private readonly sessions = new Map<string, CodexSession>();

  constructor(private readonly config: CodexCliConfig = {}) {}

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
      extensions: { codexExecJson: true, chatgptNativeLogin: true },
    };
  }

  async securityBoundary(): Promise<AgentSecurityBoundary> {
    return {
      credentialCapability: "REFERENCE_ONLY",
      environmentAllowlist: true,
      processIsolation: false,
      networkIsolation: false,
      notes: [
        "Codex CLI owns the Sign in with ChatGPT session and its local credentials",
        "MAF does not receive, persist, or inject ChatGPT cookies, OAuth tokens, or generated API keys",
        "LocalWorktree mode does not provide OS or network isolation",
      ],
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const session: CodexSession = {
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
    if (active.child) throw new Error("Codex prompt is already running");
    const prompt = [
      "MAF provides the following starting context. Keep native planning and repository search.",
      active.input.initialContext,
      "Task:",
      message,
    ].join("\n\n");
    const child = spawn(
      this.config.command ?? "codex",
      [
        "exec",
        "--experimental-json",
        "--ephemeral",
        "--full-auto",
        ...(this.config.model ? ["--model", this.config.model] : []),
        prompt,
      ],
      {
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
      },
    );
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
    child.on("close", (code) => {
      active.ended = true;
      if (code !== 0)
        this.push(active, {
          type: "error",
          data: { exitCode: code ?? 1 },
          timestamp: new Date().toISOString(),
        });
      this.wake(active);
    });
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

  async resume(): Promise<AgentSession> {
    throw new Error("Codex exec sessions are ephemeral and cannot be resumed by MAF");
  }

  private consume(session: CodexSession, line: string): void {
    const timestamp = new Date().toISOString();
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const type = String(payload.type ?? "");
      const item = (payload.item as Record<string, unknown> | undefined) ?? payload;
      const itemType = String(item.type ?? type);
      if (itemType === "agent_message") {
        this.push(session, {
          type: "message",
          data: { text: String(item.text ?? item.message ?? "") },
          timestamp,
        });
        return;
      }
      if (itemType === "command_execution" || itemType === "mcp_tool_call") {
        this.push(session, { type: "tool", data: item, timestamp });
        return;
      }
      if (type === "turn.completed" || type === "turn_complete") {
        this.push(session, { type: "complete", data: { nativeEventType: type }, timestamp });
        return;
      }
      if (type === "turn.failed" || itemType === "error") {
        this.push(session, { type: "error", data: item, timestamp });
        return;
      }
      this.push(session, { type: "tool", data: { nativeEventType: type }, timestamp });
    } catch {
      this.push(session, { type: "message", data: { text: line }, timestamp });
    }
  }

  private push(session: CodexSession, event: AgentEvent): void {
    session.queue.push(event);
    this.wake(session);
  }

  private wake(session: CodexSession): void {
    for (const waiter of session.waiters.splice(0)) waiter();
  }

  private requireSession(id: string): CodexSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown Codex CLI session: ${id}`);
    return session;
  }
}
