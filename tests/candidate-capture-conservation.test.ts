import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { runProcess } from "../src/infrastructure/process-utils";
import { createFixtureRepository, type FixtureRepository } from "./helpers";

describe("base-bound candidate capture", () => {
  let fixture: FixtureRepository | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("conserves equivalent candidate content across unstaged, staged, and committed forms", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-representation", fixture.path, "main");
    try {
      await writeFile(
        path.join(sandbox.path, "candidate.ts"),
        "export const run = (command: string): void => exec(command);\n",
        "utf8",
      );

      const unstaged = await provider.collectDiff(sandbox);
      const unstagedDigest = LocalWorktreeSandbox.digest(unstaged);
      expect(unstaged.patch).toContain("exec(command)");

      await runProcess("git", ["add", "candidate.ts"], { cwd: sandbox.path });
      const staged = await provider.collectDiff(sandbox);
      expect(staged.patch).toBe(unstaged.patch);
      expect(LocalWorktreeSandbox.digest(staged)).toBe(unstagedDigest);
      expect(staged.changedFiles).toEqual(unstaged.changedFiles);

      await runProcess("git", ["commit", "-m", "agent candidate"], { cwd: sandbox.path });
      const committed = await provider.collectDiff(sandbox);
      expect(committed.patch).toBe(unstaged.patch);
      expect(LocalWorktreeSandbox.digest(committed)).toBe(unstagedDigest);
      expect(committed.changedFiles).toEqual(unstaged.changedFiles);

      const base = await runProcess("git", ["rev-parse", "main"], { cwd: fixture.path });
      const candidateHead = await runProcess("git", ["rev-parse", "HEAD"], { cwd: sandbox.path });
      expect(sandbox.baseRevision).toBe(base.stdout.trim());
      expect(candidateHead.stdout.trim()).not.toBe(sandbox.baseRevision);
      for (const representation of [unstaged, staged, committed]) {
        expect(discoverConcerns(representation.patch).scopeAdequacy.conclusion).not.toBe(
          "ABSENCE_ESTABLISHED",
        );
      }
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("conserves mixed staged and unstaged changes against the same immutable base", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-mixed", fixture.path, "main");
    try {
      await writeFile(path.join(sandbox.path, "staged.ts"), "export const staged = 1;\n", "utf8");
      await runProcess("git", ["add", "staged.ts"], { cwd: sandbox.path });
      await writeFile(
        path.join(sandbox.path, "index.ts"),
        'export const fixture = (): string => "changed";\n',
        "utf8",
      );

      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.changedFiles.sort()).toEqual(["index.ts", "staged.ts"]);
      expect(candidate.patch).toContain("export const staged = 1;");
      expect(candidate.patch).toContain('"changed"');
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("keeps a staged modification to an already tracked file visible", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-tracked-staged", fixture.path, "main");
    try {
      await writeFile(
        path.join(sandbox.path, "index.ts"),
        "export const fixture = (command: string): void => exec(command);\n",
        "utf8",
      );
      await runProcess("git", ["add", "index.ts"], { cwd: sandbox.path });

      const staged = await provider.collectDiff(sandbox);
      expect(staged.changedFiles).toEqual(["index.ts"]);
      expect(staged.patch).toContain("exec(command)");
      expect(discoverConcerns(staged.patch).scopeAdequacy.conclusion).not.toBe(
        "ABSENCE_ESTABLISHED",
      );
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("captures ignored and info-excluded workspace bytes that verification can execute", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-ignored", fixture.path, "main");
    try {
      const excluded = "generated/verification-payload.ts";
      const excludePathResult = await runProcess(
        "git",
        ["rev-parse", "--git-path", "info/exclude"],
        {
          cwd: sandbox.path,
        },
      );
      const excludePath = path.resolve(sandbox.path, excludePathResult.stdout.trim());
      await mkdir(path.dirname(excludePath), { recursive: true });
      await writeFile(excludePath, "generated/\n", "utf8");
      await mkdir(path.join(sandbox.path, "generated"), { recursive: true });
      await writeFile(
        path.join(sandbox.path, excluded),
        "export const verificationPayload = (): void => exec(userInput);\n",
        "utf8",
      );

      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.changedFiles).toContain(excluded);
      expect(candidate.patch).toContain("exec(userInput)");
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("does not let textconv replace authoritative workspace bytes", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-textconv", fixture.path, "main");
    try {
      const attributesResult = await runProcess(
        "git",
        ["rev-parse", "--git-path", "info/attributes"],
        { cwd: sandbox.path },
      );
      const attributesPath = path.resolve(sandbox.path, attributesResult.stdout.trim());
      await mkdir(path.dirname(attributesPath), { recursive: true });
      await writeFile(attributesPath, "*.ts diff=hide-candidate\n", "utf8");
      await runProcess(
        "git",
        ["config", "diff.hide-candidate.textconv", "git show HEAD:README.md"],
        { cwd: sandbox.path },
      );
      await writeFile(
        path.join(sandbox.path, "index.ts"),
        "export const hidden = (userInput: string): void => exec(userInput);\n",
        "utf8",
      );

      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.patch).toContain("exec(userInput)");
      expect(candidate.patch).not.toContain("# Fixture");
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("fails closed when the index contains bytes absent from the verification worktree", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-index-only", fixture.path, "main");
    try {
      await writeFile(
        path.join(sandbox.path, "index.ts"),
        "export const stagedOnly = (): void => exec(userInput);\n",
        "utf8",
      );
      await runProcess("git", ["add", "index.ts"], { cwd: sandbox.path });
      await runProcess("git", ["restore", "--source=HEAD", "--worktree", "index.ts"], {
        cwd: sandbox.path,
      });

      await expect(provider.collectDiff(sandbox)).rejects.toThrow(
        /index.*worktree|worktree.*index/iu,
      );
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it.each([
    "--skip-worktree",
    "--assume-unchanged",
  ])("captures tracked edits hidden by %s metadata", async (flag) => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create(`capture-${flag.slice(2)}`, fixture.path, "main");
    try {
      await runProcess("git", ["update-index", flag, "index.ts"], { cwd: sandbox.path });
      await writeFile(
        path.join(sandbox.path, "index.ts"),
        "export const hiddenMetadata = (): void => exec(userInput);\n",
        "utf8",
      );

      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.changedFiles).toContain("index.ts");
      expect(candidate.patch).toContain("exec(userInput)");
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("captures deletion and replacement paths without rename inference", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-rename-delete", fixture.path, "main");
    try {
      await rename(path.join(sandbox.path, "index.ts"), path.join(sandbox.path, "replacement.ts"));
      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.changedFiles).toEqual(["index.ts", "replacement.ts"]);
      expect(candidate.patch).toContain('diff --git "a/index.ts" "b/index.ts"');
      expect(candidate.patch).toContain('diff --git "a/replacement.ts" "b/replacement.ts"');
      expect(candidate.patch).not.toContain("similarity index");
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("captures binary workspace bytes without projecting them as text", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-binary", fixture.path, "main");
    try {
      await writeFile(path.join(sandbox.path, "payload.bin"), Buffer.from([0, 1, 2, 255]));
      const candidate = await provider.collectDiff(sandbox);
      expect(candidate.changedFiles).toContain("payload.bin");
      expect(candidate.patch).toContain("Binary files");
      expect(candidate.identityDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });

  it("fails closed on an index-only mode change the verification workspace does not carry", async () => {
    fixture = await createFixtureRepository();
    const provider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    const sandbox = await provider.create("capture-mode-only", fixture.path, "main");
    try {
      await runProcess("git", ["update-index", "--chmod=+x", "index.ts"], { cwd: sandbox.path });
      await expect(provider.collectDiff(sandbox)).rejects.toThrow(/index.*worktree/iu);
    } finally {
      await provider.cleanup(sandbox, "VERIFIED");
    }
  });
});
