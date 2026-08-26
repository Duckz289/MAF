import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const forbiddenVendor =
  /\b(?:semgrep|opengrep|gitleaks|osv|joern|scip|trivy|snyk|codeql|temporal|litellm|langfuse|e2b|dagger|promptfoo|tencentdb|openclaw|hermes|evoagentx)\b/iu;

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(entryPath) : Promise.resolve([entryPath]);
    }),
  );
  return nested.flat();
};

describe("provider anti-corruption boundary", () => {
  it("keeps vendor identifiers out of domain and application code", async () => {
    const roots = [path.resolve("src/domain"), path.resolve("src/application")];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const leaks: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const match = source.match(forbiddenVendor);
      if (match) leaks.push(`${path.relative(process.cwd(), file)}: ${match[0]}`);
    }

    expect(
      leaks,
      `Vendor identifiers crossed the canonical boundary:\n${leaks.join("\n")}`,
    ).toEqual([]);
  });
});
