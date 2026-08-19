import { describe, expect, it } from "vitest";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { createFixtureRepository } from "./helpers";

describe("Project Brain", () => {
  it("rejects evidence-free facts", async () => {
    const brain = new InMemoryProjectBrain();
    await expect(
      brain.add({
        id: "fact",
        projectId: "project",
        revision: "a",
        kind: "FACT",
        statement: "An unsupported statement",
        evidenceIds: [],
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Facts require");
  });

  it("marks records from earlier revisions stale", async () => {
    const brain = new InMemoryProjectBrain();
    await brain.add({
      id: "evidence",
      projectId: "project",
      revision: "a",
      kind: "EVIDENCE",
      statement: "file://src/a.ts sha256:abc",
      evidenceIds: [],
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    await brain.add({
      id: "fact",
      projectId: "project",
      revision: "a",
      kind: "FACT",
      statement: "A is exported",
      evidenceIds: ["evidence"],
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    expect(await brain.markStale("project", "b")).toBe(2);
    expect(await brain.list("project", "a")).toEqual([]);
  });

  it("uses ast-grep for deterministic structural search", async () => {
    const fixture = await createFixtureRepository();
    try {
      const matches = await new LocalRepositoryIndex().structuralSearch(
        fixture.path,
        "TypeScript",
        "const $A = $B",
      );
      expect(matches.some((match) => match.startsWith("index.ts:"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
