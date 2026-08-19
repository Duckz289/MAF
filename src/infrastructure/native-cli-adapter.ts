import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../domain/ports";
import type { AgentCapabilities, AgentEvent, AgentSecurityBoundary } from "../domain/types";

interface ProcessSession extends AgentSession {
  process: ChildProcessWithoutNullStreams;
  input: AgentStartInput;
  queue: AgentEvent[];
  waiters: Array<() => void>;
  ended: boolean;
}

export interface NativeCliConfig {
  command: string;
  args: string[];
  environment?: Record<string, string>;
  capabilities?: Partial<AgentCapabilities>;
}

const defaultCapabilities: AgentCapabilities = {
  repoSearch: true,
  fileRead: true,
  fileWrite: true,
  shell: true,
  browser: false,
  mcp: true,
  nativePlanning: true,
  nativeSubagents: false,
  contextManagement: true,
  streaming: true,
  resumeSession: false,
  oauthAuth: true,
  apiKeyAuth: true,
  extensions: {},
};

export class NativeCliAdapter implements AgentAdapter {
  readonly name: string = "native-cli";
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(private readonly config: NativeCliConfig) {}

  async capabilities(): Promise<AgentCapabilities> {
    return { ...defaultCapabilities, ...this.config.capabilities };
  }

  async securityBoundary(): Promise<AgentSecurityBoundary> {
    return {
      credentialCapability: "REFERENCE_ONLY",
      environmentAllowlist: true,
      processIsolation: false,
      networkIsolation: false,
      notes: [
        "Only credential references enter the agent payload",
        "The local process and network are not OS-isolated",
      ],
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const id = crypto.randomUUID();
    const child = spawn(this.config.command, this.config.args, {
      cwd: input.workspacePath,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HARNESS_RUN_ID: input.run.id,
        HARNESS_MODE: input.run.executionMode,
        ...this.config.environment,
      },
    });
    const session: ProcessSession = {
      id,
      process: child,
      input,
      queue: [],
      waiters: [],
      ended: false,
    };
    this.sessions.set(id, session);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as AgentEvent;
        this.push(session, parsed);
      } catch {
        this.push(session, {
          type: "message",
          data: { text: line },
          timestamp: new Date().toISOString(),
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      this.push(session, {
        type: "tool",
        data: { stream: "stderr", text: chunk.toString().slice(0, 8_000) },
        timestamp: new Date().toISOString(),
      });
    });
    child.on("close", (code) => {
      session.ended = true;
      if (code !== 0) {
        this.push(session, {
          type: "error",
          data: { exitCode: code ?? 1 },
          timestamp: new Date().toISOString(),
        });
      }
      this.wake(session);
    });
    return { id };
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const active = this.requireSession(session.id);
    const payload = {
      task: active.input.task,
      context: active.input.initialContext,
      message,
      credentialReferences: active.input.credentialReferences,
    };
    active.process.stdin.write(`${JSON.stringify(payload)}\n`);
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
  }

  async cancel(session: AgentSession): Promise<void> {
    const active = this.requireSession(session.id);
    active.process.kill("SIGTERM");
  }

  async resume(): Promise<AgentSession> {
    throw new Error("This native CLI does not advertise resume support");
  }

  private requireSession(id: string): ProcessSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown agent session: ${id}`);
    return session;
  }

  private push(session: ProcessSession, event: AgentEvent): void {
    session.queue.push(event);
    this.wake(session);
  }

  private wake(session: ProcessSession): void {
    for (const waiter of session.waiters.splice(0)) waiter();
  }
}

export class APIAgentAdapter extends NativeCliAdapter {
  override readonly name = "api-agent";
}
