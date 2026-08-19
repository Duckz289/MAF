import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import path from "node:path";

interface FixtureInput {
  task: { prompt: string; signals?: { contextExpansion?: number } };
  context: string;
  credentialReferences: string[];
}

const emit = (type: string, data: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n`);
};

const lines = createInterface({ input: process.stdin });
lines.once("line", async (line) => {
  try {
    const input = JSON.parse(line) as FixtureInput;
    emit("message", { text: "Fixture native agent accepted the task" });
    if ((input.task.signals?.contextExpansion ?? 0) > 0) {
      emit("context_expansion", {
        query: "fixture dependency lookup",
        count: input.task.signals?.contextExpansion ?? 1,
      });
    }
    const content = [
      "# Native agent fixture output",
      "",
      input.task.prompt,
      "",
      `Initial context characters: ${input.context.length}`,
      `Credential references received: ${input.credentialReferences.length}`,
    ].join("\n");
    await writeFile(path.resolve("agent-output.md"), content, "utf8");
    emit("usage", {
      inputTokens: Math.ceil(input.context.length / 4),
      outputTokens: 48,
      cachedTokens: 0,
    });
    emit("complete", { changedFiles: ["agent-output.md"] });
  } catch (error) {
    emit("error", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    lines.close();
  }
});
