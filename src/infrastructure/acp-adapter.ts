import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, AgentSession, AgentStartInput } from "../domain/ports";
import type { AgentCapabilities, AgentEvent, AgentSecurityBoundary } from "../domain/types";

interface AcpProcessSession extends AgentSession {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  active: acp.ActiveSession;
  workspacePath: string;
  promptStarted: boolean;
}

export interface ACPAdapterConfig {
  command: string;
  args: string[];
  environment?: Record<string, string>;
  permissionPolicy?: "ALLOW_ONCE" | "DENY";
}

export class ACPAdapter implements AgentAdapter {
  readonly name = "acp";
  private readonly sessions = new Map<string, AcpProcessSession>();

  constructor(private readonly config: ACPAdapterConfig) {}

  async capabilities(): Promise<AgentCapabilities> {
    return {
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
      livePolicyUpdate: false,
      safeSessionRestart: false,
      oauthAuth: true,
      apiKeyAuth: true,
      extensions: { acpV1: true },
    };
  }

  async securityBoundary(): Promise<AgentSecurityBoundary> {
    return {
      credentialCapability: "REFERENCE_ONLY",
      environmentAllowlist: true,
      processIsolation: false,
      networkIsolation: false,
      notes: [
        "ACP file callbacks are constrained to the worktree",
        "The ACP subprocess is not network-isolated in LocalWorktree mode",
      ],
    };
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const child = spawn(this.config.command, this.config.args, {
      cwd: input.workspacePath,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HARNESS_RUN_ID: input.run.id,
        HARNESS_MODE: input.run.effectiveMode,
        ...this.config.environment,
      },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const workspacePath = path.resolve(input.workspacePath);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client = acp
      .client({ name: "adaptive-agent-harness" })
      .onRequest(acp.methods.client.session.requestPermission, (context) => {
        if (this.config.permissionPolicy === "ALLOW_ONCE") {
          const option = context.params.options.find(
            (candidate) => candidate.kind === "allow_once",
          );
          if (option)
            return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
        }
        return { outcome: { outcome: "cancelled" as const } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (context) => {
        const target = this.assertWorkspacePath(workspacePath, context.params.path);
        const content = await readFile(target, "utf8");
        const lines = content.split(/\r?\n/u);
        const start = Math.max(0, (context.params.line ?? 1) - 1);
        const end = context.params.limit ? start + context.params.limit : undefined;
        return { content: lines.slice(start, end).join("\n") };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (context) => {
        const target = this.assertWorkspacePath(workspacePath, context.params.path);
        await writeFile(target, context.params.content, "utf8");
        return {};
      });
    const connection = client.connect(stream);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: "adaptive-agent-harness", version: "0.1.0" },
    });
    const active = await connection.agent.buildSession(workspacePath).start();
    const id = crypto.randomUUID();
    const session: AcpProcessSession = {
      id,
      nativeSessionId: active.sessionId,
      child,
      connection,
      active,
      workspacePath,
      promptStarted: false,
    };
    this.sessions.set(id, session);
    return { id, nativeSessionId: active.sessionId };
  }

  async send(session: AgentSession, message: string): Promise<void> {
    const active = this.requireSession(session.id);
    if (active.promptStarted) throw new Error("ACP session already has an active prompt");
    active.promptStarted = true;
    void active.active.prompt(message);
  }

  async *events(session: AgentSession): AsyncIterable<AgentEvent> {
    const active = this.requireSession(session.id);
    try {
      for (;;) {
        const message = await active.active.nextUpdate();
        if (message.kind === "stop") {
          yield {
            type: "complete",
            data: { stopReason: message.stopReason, nativeSessionId: active.active.sessionId },
            timestamp: new Date().toISOString(),
          };
          break;
        }
        const update = message.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          yield {
            type: "message",
            data: { text: update.content.text, native: update },
            timestamp: new Date().toISOString(),
          };
        } else if (update.sessionUpdate === "usage_update") {
          yield {
            type: "usage",
            data: { inputTokens: update.used, outputTokens: 0, cachedTokens: 0, native: update },
            timestamp: new Date().toISOString(),
          };
        } else {
          yield {
            type: "tool",
            data: { updateType: update.sessionUpdate, native: update },
            timestamp: new Date().toISOString(),
          };
        }
      }
    } finally {
      active.active.dispose();
      active.connection.close();
      active.child.kill("SIGTERM");
      this.sessions.delete(active.id);
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const active = this.requireSession(session.id);
    await active.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: active.active.sessionId,
    });
  }

  async resume(): Promise<AgentSession> {
    throw new Error(
      "ACP resume requires persisted native session configuration and is disabled in V0",
    );
  }

  private requireSession(id: string): AcpProcessSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown ACP session: ${id}`);
    return session;
  }

  private assertWorkspacePath(workspacePath: string, requested: string): string {
    const target = path.resolve(requested);
    const relative = path.relative(workspacePath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("ACP file request escapes the isolated workspace");
    }
    return target;
  }
}
