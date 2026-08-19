import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../src/infrastructure/process-utils";

export interface FixtureRepository {
  path: string;
  sandboxRoot: string;
  cleanup: () => Promise<void>;
}

export const createFixtureRepository = async (): Promise<FixtureRepository> => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-harness-test-"));
  const directory = path.join(root, "repository");
  const sandboxRoot = path.join(root, "sandboxes");
  await mkdir(directory);
  await runProcess("git", ["init", "-b", "main"], { cwd: directory });
  await runProcess("git", ["config", "user.email", "harness-test@example.invalid"], {
    cwd: directory,
  });
  await runProcess("git", ["config", "user.name", "Harness Test"], { cwd: directory });
  await writeFile(path.join(directory, "README.md"), "# Fixture\n", "utf8");
  await writeFile(
    path.join(directory, "index.ts"),
    'export const fixture = (): string => "ready";\n',
    "utf8",
  );
  await runProcess("git", ["add", "."], { cwd: directory });
  await runProcess("git", ["commit", "-m", "fixture baseline"], { cwd: directory });
  return {
    path: directory,
    sandboxRoot,
    cleanup: async () => {
      await runProcess("git", ["worktree", "prune"], { cwd: directory });
      await rm(root, { recursive: true, force: true });
    },
  };
};

export const createAdaptiveFixtureRepository = async (): Promise<FixtureRepository> => {
  const fixture = await createFixtureRepository();
  const modules: Record<string, string> = {
    "frontend/image.ts":
      'import { loadMedia } from "../api/media";\nexport const renderImage = loadMedia;\n',
    "api/media.ts":
      'import { resolveMedia } from "../storage/resolver";\nexport const loadMedia = resolveMedia;\n',
    "storage/resolver.ts":
      'import { canReadMedia } from "../auth/permissions";\nexport const resolveMedia = (): boolean => canReadMedia();\n',
    "auth/permissions.ts": "export const canReadMedia = (): boolean => true;\n",
  };
  for (const [file, source] of Object.entries(modules)) {
    const target = path.join(fixture.path, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  await runProcess("git", ["add", "."], { cwd: fixture.path });
  await runProcess("git", ["commit", "-m", "adaptive dependency fixture"], {
    cwd: fixture.path,
  });
  return fixture;
};

export const waitFor = async <T>(
  read: () => Promise<T>,
  complete: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> => {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await read();
    if (complete(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition did not complete in ${timeoutMs}ms`);
};
