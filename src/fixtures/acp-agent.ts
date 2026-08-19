import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string }>();
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "adaptive-harness-acp-fixture" })
  .onRequest(acp.methods.agent.initialize, (context) => ({
    protocolVersion: context.params.protocolVersion,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "adaptive-harness-acp-fixture", version: "0.1.0" },
  }))
  .onRequest(acp.methods.agent.session.new, (context) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: context.params.cwd });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const session = sessions.get(context.params.sessionId);
    if (!session) throw new Error("Unknown fixture session");
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ACP fixture accepted the prompt" },
      },
    });
    await writeFile(path.join(session.cwd, "acp-output.md"), "# ACP fixture output\n", "utf8");
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: { sessionUpdate: "usage_update", used: 32, size: 128_000 },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(stream);
