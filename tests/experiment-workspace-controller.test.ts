import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ExperimentWorkspaceController } from "../evaluation/experiments/real/lib/workspace-controller";

const execFileAsync = promisify(execFile);

let pristineRepo: string | undefined;

afterEach(async () => {
  if (pristineRepo) await rm(pristineRepo, { recursive: true, force: true });
  pristineRepo = undefined;
});

describe("ExperimentWorkspaceController", () => {
  it("materializes byte-identical, independently git-tracked workspaces per arm", async () => {
    pristineRepo = await mkdtemp(path.join(tmpdir(), "maf-workspace-controller-pristine-"));
    await writeFile(path.join(pristineRepo, "example.txt"), "hello world\n", "utf8");

    const controller = new ExperimentWorkspaceController();
    const nativeWorkspace = await controller.createCandidateWorkspace("NATIVE", pristineRepo);
    const mafWorkspace = await controller.createCandidateWorkspace("MAF", pristineRepo);

    expect(nativeWorkspace).not.toBe(mafWorkspace);
    const nativeContent = await readFile(path.join(nativeWorkspace, "example.txt"), "utf8");
    const mafContent = await readFile(path.join(mafWorkspace, "example.txt"), "utf8");
    expect(nativeContent).toBe("hello world\n");
    expect(mafContent).toBe("hello world\n");

    // Both workspaces must be git repositories with the seed content tracked, since the real MAF
    // executor's context strategy (LocalRepositoryIndex) shells out to `git ls-files`.
    const { stdout: nativeFiles } = await execFileAsync("git", ["ls-files"], {
      cwd: nativeWorkspace,
    });
    const { stdout: mafFiles } = await execFileAsync("git", ["ls-files"], { cwd: mafWorkspace });
    expect(nativeFiles.trim().split(/\r?\n/u)).toContain("example.txt");
    expect(mafFiles.trim().split(/\r?\n/u)).toContain("example.txt");

    expect(controller.listWorkspaces()).toHaveLength(2);

    await controller.cleanup();
    await expect(readFile(path.join(nativeWorkspace, "example.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(mafWorkspace, "example.txt"), "utf8")).rejects.toThrow();
    expect(controller.listWorkspaces()).toHaveLength(0);
  });

  it("cleanup() is safe to call more than once", async () => {
    const controller = new ExperimentWorkspaceController();
    await controller.cleanup();
    await controller.cleanup();
    expect(controller.listWorkspaces()).toHaveLength(0);
  });
});
