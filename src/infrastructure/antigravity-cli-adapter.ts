import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../domain/ports";
import type { AgentCapabilities, AgentEvent, AgentSecurityBoundary } from "../domain/types";
import { resolveAntigravityCommand } from "./native-agent-auth";

interface AntigravitySession extends AgentSession {
  input: AgentStartInput;
  child?: ChildProcessWithoutNullStreams;
  queue: AgentEvent[];
  waiters: Array<() => void>;
  ended: boolean;
}

export interface AntigravityCliConfig {
  command?: string;
  model?: string;
}

/**
 * Drives Antigravity's official headless `agy` companion. Authentication remains entirely in the
 * signed-in Antigravity IDE; MAF neither reads nor stores its cookies, keyring entries, or tokens.
 */
export class AntigravityCliAdapter implements AgentAdapter {
  readonly name = "antigravity-cli";
  private readonly sessions = new Map<string, AntigravitySession>();

  constructor(private readonly config: AntigravityCliConfig = {}) {}

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
      apiKeyAuth: false,
      extensions: { antigravityStreamJson: true, antigravityIdeSession: true },
    };
  }

  async securityBoundary(): Promise<AgentSecurityBoundary> {
    return {
      credentialCapability: "REFERENCE_ONLY",
      environmentAllowlist: true,
      processIsolation: false,
      networkIsolation: false,
      notes: [
        "Antigravity IDE owns Google account authentication and quota",
        "MAF does not read Antigravity credential files, cookies, keyring entries, or API keys",
        "LocalWorktree mode does not provide OS or network isolation",
      ],
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const session: AntigravitySession = {
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
    if (active.child) throw new Error("Antigravity prompt is already running");
    const prompt = ["MAF starting context:", active.input.initialContext, "Task:", message].join(
      "\n\n",
    );
    const child = spawn(
      this.config.command ?? resolveAntigravityCommand(),
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--print-timeout",
        "24h0m0s",
        // `agy` otherwise selects an internal scratch workspace instead of the MAF worktree.
        "--add-dir",
        active.input.workspacePath,
        ...(this.config.model ? ["--model", this.config.model] : []),
      ],
      { cwd: active.input.workspacePath, windowsHide: true, env: nativeEnvironment(active.input) },
    );
    active.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.consume(active, line));
    child.once("error", (error) => this.push(active, event("error", { message: error.message })));
    child.stderr.on("data", (chunk) =>
      this.push(
        active,
        event("tool", { stream: "stderr", text: chunk.toString().slice(0, 8_000) }),
      ),
    );
    child.on("close", (code) => {
      active.ended = true;
      if (code !== 0) this.push(active, event("error", { exitCode: code ?? 1 }));
      this.wake(active);
    });
  }

  async *events(session: AgentSession): AsyncIterable<AgentEvent> {
    const active = this.requireSession(session.id);
    while (!active.ended || active.queue.length) {
      const next = active.queue.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => active.waiters.push(resolve));
    }
    this.sessions.delete(active.id);
  }

  async cancel(session: AgentSession): Promise<void> {
    this.requireSession(session.id).child?.kill("SIGTERM");
  }

  async resume(): Promise<AgentSession> {
    throw new Error("Antigravity CLI sessions are not resumed by MAF");
  }

  private consume(session: AntigravitySession, line: string): void {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const type = String(raw.event ?? "");
      if (type === "step_update") {
        const step = record(raw.step_update);
        const stepType = String(step.step_type ?? "");
        if (stepType === "agent_response") {
          const text = String(step.text_delta ?? "");
          if (text) this.push(session, event("message", { text }));
        } else if (stepType === "tool") this.push(session, event("tool", step));
        else this.push(session, event("tool", { nativeEventType: stepType }));
      } else if (type === "result") {
        const result = record(raw.result);
        const response = typeof result.response === "string" ? result.response : "";
        if (response) this.push(session, event("message", { text: response }));
        if (result.status === "SUCCESS")
          this.push(session, event("complete", { nativeEventType: type }));
        else this.push(session, event("error", { nativeEventType: type }));
      } else if (type === "init") this.push(session, event("tool", { nativeEventType: type }));
      else this.push(session, event("tool", { nativeEventType: type }));
    } catch {
      this.push(session, event("message", { text: line }));
    }
  }

  private push(session: AntigravitySession, next: AgentEvent): void {
    session.queue.push(next);
    this.wake(session);
  }

  private wake(session: AntigravitySession): void {
    for (const resolve of session.waiters.splice(0)) resolve();
  }

  private requireSession(id: string): AntigravitySession {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`Unknown Antigravity CLI session: ${id}`);
    return found;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const event = (type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent => ({
  type,
  data,
  timestamp: new Date().toISOString(),
});

const nativeEnvironment = (input: AgentStartInput): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  HARNESS_RUN_ID: input.run.id,
  HARNESS_MODE: input.run.effectiveMode,
});
