import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryProjectBrain,
  LocalRepositoryIndex,
  OptionalCodebaseMemoryIndex,
} from "../src/infrastructure/project-brain";
import { runProcess } from "../src/infrastructure/process-utils";
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

  it("keeps the cheap full pass free of symbols/relations until indexScope is called", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const snapshot = await new LocalRepositoryIndex().index(fixture.path, "HEAD");
      expect(snapshot.symbols).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(snapshot.parsedFiles).toEqual([]);
      expect(snapshot.filesTruncated).toBe(false);
      // But module/package ownership are derived from paths alone and are complete immediately.
      expect(snapshot.moduleOwnership["src/web/image.ts"]).toBe("src/web");
    } finally {
      await fixture.cleanup();
    }
  });

  it("resolves local import edges via bounded indexScope and reports optional MCP fallback honestly", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      const cheap = await local.index(fixture.path, "HEAD");
      const scoped = await local.indexScope(fixture.path, "HEAD", cheap, [
        "src/web/image.ts",
        "src/application/media.ts",
      ]);
      expect(scoped.parsedFiles.sort()).toEqual(["src/application/media.ts", "src/web/image.ts"]);
      expect(scoped.relations).toContainEqual({
        from: "src/web/image.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
      // Files outside the requested scope stay unparsed — this is the bounded part of "bounded
      // incremental discovery": indexScope never silently expands beyond what was asked.
      expect(scoped.parsedFiles).not.toContain("src/domain/permissions.ts");
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

  it("indexes side-effect and CommonJS local import relations", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      await writeFile(
        path.join(fixture.path, "src/web/image.ts"),
        'import "../domain/permissions";\nconst media = require("../application/media");\n',
        "utf8",
      );
      const local = new LocalRepositoryIndex();
      const cheap = await local.index(fixture.path, "HEAD");
      const scoped = await local.indexScope(fixture.path, "HEAD", cheap, ["src/web/image.ts"]);
      expect(scoped.relations).toEqual(
        expect.arrayContaining([
          {
            from: "src/web/image.ts",
            to: "src/domain/permissions.ts",
            kind: "IMPORTS",
          },
          {
            from: "src/web/image.ts",
            to: "src/application/media.ts",
            kind: "IMPORTS",
          },
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("grows the graph incrementally without re-parsing already-scoped files", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      const cheap = await local.index(fixture.path, "HEAD");
      const firstPass = await local.indexScope(fixture.path, "HEAD", cheap, ["src/web/image.ts"]);
      expect(firstPass.parsedFiles).toEqual(["src/web/image.ts"]);
      // Requesting the same file again is a no-op — the identical snapshot instance is returned.
      const noop = await local.indexScope(fixture.path, "HEAD", firstPass, ["src/web/image.ts"]);
      expect(noop).toBe(firstPass);
      // Requesting a new file only parses that new file, merging onto the existing scope.
      const secondPass = await local.indexScope(fixture.path, "HEAD", firstPass, [
        "src/application/media.ts",
      ]);
      expect(secondPass.parsedFiles.sort()).toEqual([
        "src/application/media.ts",
        "src/web/image.ts",
      ]);
      expect(secondPass.relations).toContainEqual({
        from: "src/web/image.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("re-parses a file whose content changed since it was last scope-indexed", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      const cheap = await local.index(fixture.path, "HEAD");
      const target = path.join(fixture.path, "src/web/image.ts");
      const firstPass = await local.indexScope(fixture.path, "HEAD", cheap, ["src/web/image.ts"]);
      expect(firstPass.relations).toContainEqual({
        from: "src/web/image.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
      // Edit the file on disk (as an agent would) to import a different module, without a new
      // git commit — indexScope must react to content, not revision label or prior attempt state.
      await writeFile(
        target,
        'import { canReadMedia } from "../domain/permissions";\nexport const renderImage = canReadMedia;\n',
        "utf8",
      );
      const rescanned = await local.indexScope(fixture.path, "HEAD", firstPass, [
        "src/web/image.ts",
      ]);
      // The snapshot instance changed (this was not a no-op)...
      expect(rescanned).not.toBe(firstPass);
      // ...the stale relation is gone...
      expect(rescanned.relations).not.toContainEqual({
        from: "src/web/image.ts",
        to: "src/application/media.ts",
        kind: "IMPORTS",
      });
      // ...and the fresh relation reflecting the actual current content is present.
      expect(rescanned.relations).toContainEqual({
        from: "src/web/image.ts",
        to: "src/domain/permissions.ts",
        kind: "IMPORTS",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("registers a file created mid-run and resolves imports that target it", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      const cheap = await local.index(fixture.path, "HEAD");
      expect(cheap.files).not.toContain("src/web/gallery.ts");
      // Simulate the agent creating a brand-new file after the initial (frozen) file listing.
      await writeFile(
        path.join(fixture.path, "src/web/gallery.ts"),
        'import { renderImage } from "./image";\nexport const gallery = renderImage;\n',
        "utf8",
      );
      const grown = await local.indexScope(fixture.path, "HEAD", cheap, [
        "src/web/image.ts",
        "src/web/gallery.ts",
      ]);
      expect(grown.files).toContain("src/web/gallery.ts");
      expect(grown.moduleOwnership["src/web/gallery.ts"]).toBe("src/web");
      expect(grown.relations).toContainEqual({
        from: "src/web/gallery.ts",
        to: "src/web/image.ts",
        kind: "IMPORTS",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("derives architectural src modules from paths alone without fragmenting a layer", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    try {
      const snapshot = await new LocalRepositoryIndex().index(fixture.path, "HEAD");
      expect(Object.keys(snapshot.moduleMap)).toEqual(
        expect.arrayContaining(["src/application", "src/domain", "src/infrastructure", "src/web"]),
      );
      expect(snapshot.moduleOwnership["src/application/media.ts"]).toBe("src/application");
      expect(snapshot.moduleOwnership["src/application/controller.ts"]).toBe("src/application");
      // Single-package repository: package ownership collapses to "root" for every file, while
      // the deeper architectural module distinguishes src layers.
      expect(snapshot.packageOwnership["src/application/media.ts"]).toBe("root");
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
      // Package ownership mirrors module ownership here because none of these files live under a
      // deeper src/<layer> convention within their package.
      expect(snapshot.packageOwnership).toMatchObject({
        "apps/web/index.ts": "apps/web",
        "apps/api/index.ts": "apps/api",
        "packages/shared/index.ts": "packages/shared",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("distinguishes a package from a deeper architectural module inside it", async () => {
    const fixture = await createMonorepoFixtureRepository();
    try {
      const local = new LocalRepositoryIndex();
      // Add a file that lives one src/<layer> deeper than the package root to prove the
      // package/module split the milestone calls for (package apps/web, module
      // apps/web/src/domain), without depending on a fixture helper rewrite.
      const target = path.join(fixture.path, "apps/web/src/domain/order.ts");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const order = 1;\n", "utf8");
      await runProcess("git", ["add", "."], { cwd: fixture.path });
      await runProcess("git", ["commit", "-m", "add deeper module"], { cwd: fixture.path });
      const snapshot = await local.index(fixture.path, "HEAD");
      expect(snapshot.packageOwnership["apps/web/src/domain/order.ts"]).toBe("apps/web");
      expect(snapshot.moduleOwnership["apps/web/src/domain/order.ts"]).toBe("apps/web/src/domain");
    } finally {
      await fixture.cleanup();
    }
  });

  it(
    "keeps module/package ownership complete beyond the old 500-file parse cap",
    { timeout: 30_000 },
    async () => {
      // Regression test for the milestone's core bug: the pre-M2 index() silently built
      // moduleMap/moduleOwnership only from the first 500 files it happened to content-parse, in
      // git ls-files listing order. "filler/" sorts before "src/" alphabetically, so on the old
      // implementation these 520 filler files would have consumed the entire cap and the real
      // src/* modules below would have been completely absent from the graph.
      const fixture = await createAdaptiveFixtureRepository();
      try {
        const fillerCount = 520;
        for (let index = 0; index < fillerCount; index += 1) {
          const file = path.join(fixture.path, "filler", `a${String(index).padStart(4, "0")}.ts`);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, `export const filler${index} = ${index};\n`, "utf8");
        }
        await runProcess("git", ["add", "."], { cwd: fixture.path });
        await runProcess("git", ["commit", "-m", "add filler files"], { cwd: fixture.path });
        const local = new LocalRepositoryIndex();
        const snapshot = await local.index(fixture.path, "HEAD");
        expect(snapshot.files.length).toBeGreaterThan(500);
        expect(snapshot.filesTruncated).toBe(false);
        expect(Object.keys(snapshot.moduleMap)).toEqual(
          expect.arrayContaining([
            "src/application",
            "src/domain",
            "src/infrastructure",
            "src/web",
          ]),
        );
        expect(snapshot.moduleOwnership["src/domain/permissions.ts"]).toBe("src/domain");
        // The full import chain still resolves once scope-indexed, proving the module graph and
        // the file-existence set used to resolve local imports both survived past the old cap.
        const scoped = await local.indexScope(fixture.path, "HEAD", snapshot, [
          "src/infrastructure/resolver.ts",
        ]);
        expect(scoped.relations).toContainEqual({
          from: "src/infrastructure/resolver.ts",
          to: "src/domain/permissions.ts",
          kind: "IMPORTS",
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
