import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

it("keeps the reconstructed evaluation corpus complete and local-only", async () => {
  const protocol = await readJson<{
    protocolVersion: string;
    execution: { frontierRunsPermitted: boolean };
  }>("evaluation/protocol.json");
  const phaseB = await readJson<{ tasks: unknown[] }>("evaluation/phase-b/manifest.json");
  const phaseC = await readJson<{ bands: Record<string, string[]> }>(
    "evaluation/phase-c/manifest.json",
  );

  expect(protocol.protocolVersion).toBe("2.0.0-reconstructed");
  expect(protocol.execution.frontierRunsPermitted).toBe(false);
  expect(phaseB.tasks).toHaveLength(12);
  expect(
    Object.fromEntries(Object.entries(phaseC.bands).map(([band, ids]) => [band, ids.length])),
  ).toEqual({
    band1: 5,
    band2: 7,
    band3: 5,
  });
});

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8")) as T;
}
