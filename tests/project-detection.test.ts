import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/infrastructure/process-utils";
import {
  browseDirectory,
  detectProject,
  listFilesystemRoots,
} from "../src/infrastructure/project-detection";
import {
  createFixtureRepository,
  createMonorepoFixtureRepository,
  type FixtureRepository,
} from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("local filesystem browsing", () => {
  it("lists at least one real root the OS actually has", async () => {
    const roots = await listFilesystemRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root.path.length).toBeGreaterThan(0);
  });

  it("lists real subdirectories and flags an unreadable path honestly rather than pretending empty", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const nested = path.join(fixture.path, "child-one");
    await mkdir(nested);
    const listing = await browseDirectory(fixture.path);
    expect(listing.unreadable).toBe(false);
    expect(listing.entries.map((entry) => entry.name)).toContain("child-one");
    expect(listing.entries.find((entry) => entry.name === "child-one")?.looksLikeGitRepo).toBe(
      false,
    );

    const missing = await browseDirectory(path.join(fixture.path, "does-not-exist"));
    expect(missing.unreadable).toBe(true);
    expect(missing.entries).toEqual([]);
  });

  it("hides node_modules/.git and other noise directories from the picker", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    await mkdir(path.join(fixture.path, "node_modules"));
    await mkdir(path.join(fixture.path, "src"));
    const listing = await browseDirectory(fixture.path);
    const names = listing.entries.map((entry) => entry.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).toContain("src");
  });
});

describe("deterministic project detection", () => {
  it("never claims detection for a path that does not exist", async () => {
    const result = await detectProject(
      path.join(process.cwd(), "definitely-not-a-real-directory-xyz"),
    );
    expect(result.exists).toBe(false);
    expect(result.git.present).toBe(false);
    expect(result.languages).toEqual([]);
    expect(result.unknowns.length).toBeGreaterThan(0);
  });

  it("reads real git branch/revision/dirty state and reports no-package.json honestly", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const result = await detectProject(fixture.path);
    expect(result.exists).toBe(true);
    expect(result.git.present).toBe(true);
    expect(result.git.revision).toMatch(/^[a-f0-9]+$/u);
    expect(result.git.dirty).toBe(false);
    expect(result.unknowns).toContain(
      "no package.json found — Node/TypeScript scripts could not be read",
    );

    await writeFile(path.join(fixture.path, "untracked.txt"), "dirty\n", "utf8");
    const dirtyResult = await detectProject(fixture.path);
    expect(dirtyResult.git.dirty).toBe(true);
  });

  it("reads real npm scripts verbatim rather than guessing commands", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    await writeFile(
      path.join(fixture.path, "package.json"),
      JSON.stringify({
        name: "fixture",
        dependencies: { react: "^19.0.0", fastify: "^5.0.0" },
        scripts: { test: "vitest run", build: "tsc -b", lint: "biome lint ." },
      }),
      "utf8",
    );
    await runProcess("git", ["add", "."], { cwd: fixture.path });
    await runProcess("git", ["commit", "-m", "add manifest"], { cwd: fixture.path });
    const result = await detectProject(fixture.path);
    expect(result.frameworks).toEqual(["Fastify", "React"]);
    expect(result.verificationCommands).toContainEqual({
      label: "Kiểm thử",
      command: "npm run test",
    });
    expect(result.verificationCommands).toContainEqual({
      label: "Build",
      command: "npm run build",
    });
    // typecheck was never declared in scripts, so it must never be reported as discovered.
    expect(result.verificationCommands.some((entry) => entry.label === "Kiểm tra kiểu")).toBe(
      false,
    );
  });

  it("detects workspace/module roots for a monorepo without dumping every file", async () => {
    const fixture = await createMonorepoFixtureRepository();
    fixtures.push(fixture);
    const result = await detectProject(fixture.path);
    expect(result.monorepo).toBe(true);
    expect(result.moduleRoots.length).toBeGreaterThan(1);
    expect(result.trackedFileCount).toBeGreaterThan(0);
  });
});
