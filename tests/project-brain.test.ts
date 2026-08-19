import { describe, expect, it } from "vitest";
import {
  InMemoryProjectBrain,
  LocalRepositoryIndex,
  OptionalCodebaseMemoryIndex,
} from "../src/infrastructure/project-brain";
import {
  createAdaptiveFixtureRepository,
  createFixtureRepository,
  createMonorepoFixtureRepository,
} from "./helpers";

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

  it("resolves local import edges and reports optional MCP fallback honestly", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      const snapshot = await local.index(fixture.path, "HEAD");
      expect(snapshot.relations).toContainEqual({
        from: "src/web/image.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
      const optional = new OptionalCodebaseMemoryIndex(local);
      expect(optional.status()).toMatchObject({
        capability: "OPTIONAL_PORT",
        active: false,
        fallbackEngine: "local-deterministic-index",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("derives architectural src modules without fragmenting files inside a layer", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const snapshot = await new LocalRepositoryIndex().index(fixture.path, "HEAD");
      expect(Object.keys(snapshot.moduleMap)).toEqual(
        expect.arrayContaining(["src/application", "src/domain", "src/infrastructure", "src/web"]),
      );
      expect(snapshot.moduleOwnership["src/application/media.ts"]).toBe("src/application");
      expect(snapshot.moduleOwnership["src/application/controller.ts"]).toBe("src/application");
      expect(snapshot.relations).toContainEqual({
        from: "src/application/controller.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves apps and packages workspace boundaries", async () => {
    const fixture = await createMonorepoFixtureRepository();
    try {
      const snapshot = await new LocalRepositoryIndex().index(fixture.path, "HEAD");
      expect(snapshot.moduleRoots).toEqual(
        expect.arrayContaining(["apps/api", "apps/web", "packages/shared"]),
      );
      expect(snapshot.moduleOwnership).toMatchObject({
        "apps/web/index.ts": "apps/web",
        "apps/api/index.ts": "apps/api",
        "packages/shared/index.ts": "packages/shared",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
