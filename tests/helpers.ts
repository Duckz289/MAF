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
    "src/web/image.ts":
      'import { loadMedia } from "../application/media";\nexport const renderImage = loadMedia;\n',
    "src/application/media.ts":
      'import { resolveMedia } from "../infrastructure/resolver";\nexport const loadMedia = resolveMedia;\n',
    "src/application/controller.ts":
      'import { loadMedia } from "./media";\nexport const controller = loadMedia;\n',
    "src/infrastructure/resolver.ts":
      'import { canReadMedia } from "../domain/permissions";\nexport const resolveMedia = (): boolean => canReadMedia();\n',
    "src/domain/permissions.ts": "export const canReadMedia = (): boolean => true;\n",
    "src/api/routes.ts": "export const routes: string[] = [];\n",
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

export const createSecuritySensitiveFixtureRepository = async (): Promise<FixtureRepository> => {
  const fixture = await createFixtureRepository();
  const target = path.join(fixture.path, "src/domain/auth-service.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    "export const authenticateSession = (token: string): boolean => token.length > 0;\n",
    "utf8",
  );
  await runProcess("git", ["add", "."], { cwd: fixture.path });
  await runProcess("git", ["commit", "-m", "auth fixture"], { cwd: fixture.path });
  return fixture;
};

export const createMonorepoFixtureRepository = async (): Promise<FixtureRepository> => {
  const fixture = await createFixtureRepository();
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "@fixture/web" }),
    "apps/web/index.ts":
      'import { apiValue } from "../api/index";\nexport const webValue = apiValue;\n',
    "apps/api/package.json": JSON.stringify({ name: "@fixture/api" }),
    "apps/api/index.ts":
      'import { sharedValue } from "../../packages/shared/index";\nexport const apiValue = sharedValue;\n',
    "packages/shared/package.json": JSON.stringify({ name: "@fixture/shared" }),
    "packages/shared/index.ts": "export const sharedValue = true;\n",
  };
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(fixture.path, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  await runProcess("git", ["add", "."], { cwd: fixture.path });
  await runProcess("git", ["commit", "-m", "workspace fixture"], { cwd: fixture.path });
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
