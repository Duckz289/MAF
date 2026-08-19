import { createInterface } from "node:readline";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface FixtureInput {
  task: {
    prompt: string;
    signals?: { contextExpansion?: number };
    verification?: { expectedFile?: string };
  };
  context: string;
  credentialReferences: string[];
  message: string;
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
    const adaptivePaths = [
      "src/web/image.ts",
      "src/application/media.ts",
      "src/infrastructure/resolver.ts",
      "src/domain/permissions.ts",
    ];
    const adaptiveRepository = await Promise.all(
      adaptivePaths.map(async (file) => {
        try {
          await access(path.resolve(file));
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (adaptiveRepository.every(Boolean)) {
      for (const file of adaptivePaths) emit("tool", { tool: "read_file", path: file });
      if (/stabili[sz]e/iu.test(input.task.prompt)) {
        for (let index = 0; index < 5; index += 1) {
          emit("tool", {
            tool: "edit_file",
            operation: "edit",
            path: "src/domain/permissions.ts",
            pass: index + 1,
          });
        }
      }
    }
    let environmentProbe = "not-requested";
    let dotenvProbe = "not-requested";
    if (/credential boundary probe/iu.test(input.task.prompt)) {
      environmentProbe = process.env.MAF_MANAGED_PROVIDER_SECRET ?? "absent";
      try {
        dotenvProbe = (await readFile(path.resolve(".env"), "utf8")).slice(0, 200);
      } catch {
        dotenvProbe = "absent";
      }
      emit("tool", {
        tool: "credential_probe",
        environmentSecret: environmentProbe,
        dotenvContent: dotenvProbe,
        credentialReferences: input.credentialReferences,
      });
    }
    const content = [
      "# Native agent fixture output",
      "",
      input.task.prompt,
      "",
      `Initial context characters: ${input.context.length}`,
      `Credential references received: ${input.credentialReferences.length}`,
      `Credential reference values: ${input.credentialReferences.join(",") || "none"}`,
      `Managed provider secret visible: ${environmentProbe}`,
      `Dotenv visible: ${dotenvProbe}`,
    ].join("\n");
    await writeFile(path.resolve("agent-output.md"), content, "utf8");
    if (
      /repair succeeds/iu.test(input.task.prompt) &&
      /Trusted verification repair request/iu.test(input.message) &&
      input.task.verification?.expectedFile
    ) {
      await writeFile(path.resolve(input.task.verification.expectedFile), "repaired\n", "utf8");
      emit("tool", {
        tool: "write_file",
        operation: "create",
        path: input.task.verification.expectedFile,
      });
    }
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
