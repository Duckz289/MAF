import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process-utils";

/**
 * Local-filesystem browsing and deterministic project detection for the "Add project" flow.
 *
 * MAF is a local-first tool: the Fastify server already runs on the user's own machine with full
 * filesystem access, so a browser `<input webkitdirectory>` picker (which cannot hand back a
 * usable absolute path) is the wrong bridge. Instead the backend exposes a bounded directory
 * listing the UI renders as a folder browser — the smallest honest local bridge for this
 * architecture, per the product brief. Detection never claims a fact it cannot evidence: an
 * ecosystem file simply absent means the corresponding field stays empty, not guessed.
 */

const gitTimeoutMs = 5_000;

export interface DirectoryEntry {
  name: string;
  path: string;
  looksLikeGitRepo: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  /** True when the directory could not be read (permissions, deleted, etc.) — never silently empty. */
  unreadable: boolean;
}

/** Directories never worth showing in a repository picker — hidden VCS/build/dependency output. */
const hiddenDirectoryNames = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "$Recycle.Bin",
  "System Volume Information",
]);

export const listFilesystemRoots = async (): Promise<DirectoryEntry[]> => {
  if (process.platform === "win32") {
    const candidates = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`);
    const checks = await Promise.all(
      candidates.map(async (drive) => {
        try {
          await stat(drive);
          return drive;
        } catch {
          return undefined;
        }
      }),
    );
    return checks
      .filter((drive): drive is string => drive !== undefined)
      .map((drive) => ({ name: drive, path: drive, looksLikeGitRepo: false }));
  }
  return [{ name: "/", path: "/", looksLikeGitRepo: existsSync("/.git") }];
};

export const defaultBrowseStart = (): string => os.homedir();

export const browseDirectory = async (requestedPath: string): Promise<DirectoryListing> => {
  const resolved = path.resolve(requestedPath);
  let direntries: Dirent<string>[];
  try {
    direntries = await readdir(resolved, { withFileTypes: true, encoding: "utf8" });
  } catch {
    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      entries: [],
      unreadable: true,
    };
  }
  const entries = direntries
    .filter((entry) => entry.isDirectory() && !hiddenDirectoryNames.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => {
      const entryPath = path.join(resolved, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        looksLikeGitRepo: existsSync(path.join(entryPath, ".git")),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries,
    unreadable: false,
  };
};

export interface GitDetection {
  present: boolean;
  branch?: string;
  revision?: string;
  dirty?: boolean;
}

const detectGit = async (repositoryPath: string): Promise<GitDetection> => {
  const check = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repositoryPath,
    timeoutMs: gitTimeoutMs,
  });
  if (check.exitCode !== 0 || check.stdout.trim() !== "true") return { present: false };
  const [branch, revision, status] = await Promise.all([
    runProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repositoryPath,
      timeoutMs: gitTimeoutMs,
    }),
    runProcess("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repositoryPath,
      timeoutMs: gitTimeoutMs,
    }),
    runProcess("git", ["status", "--porcelain=v1"], {
      cwd: repositoryPath,
      timeoutMs: gitTimeoutMs,
    }),
  ]);
  return {
    present: true,
    ...(branch.exitCode === 0 ? { branch: branch.stdout.trim() } : {}),
    ...(revision.exitCode === 0 ? { revision: revision.stdout.trim() } : {}),
    ...(status.exitCode === 0 ? { dirty: status.stdout.trim().length > 0 } : {}),
  };
};

const readJsonIfPresent = async (file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** package.json dependency name -> human framework label. Presence-based, never inferred. */
const frameworkByDependency: Record<string, string> = {
  react: "React",
  "react-dom": "React",
  next: "Next.js",
  vue: "Vue",
  "@angular/core": "Angular",
  svelte: "Svelte",
  fastify: "Fastify",
  express: "Express",
  "@nestjs/core": "NestJS",
  koa: "Koa",
  vite: "Vite",
  vitest: "Vitest",
  jest: "Jest",
  "@fluentui/react-components": "Fluent UI",
  tailwindcss: "Tailwind CSS",
};

const ecosystemManifests: Array<{ file: string; label: string }> = [
  { file: "Cargo.toml", label: "Rust" },
  { file: "go.mod", label: "Go" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "pom.xml", label: "Java" },
  { file: "build.gradle", label: "Java/Kotlin" },
  { file: "build.gradle.kts", label: "Kotlin" },
  { file: "Gemfile", label: "Ruby" },
  { file: "composer.json", label: "PHP" },
];

export interface ProjectDetection {
  repositoryPath: string;
  exists: boolean;
  git: GitDetection;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  verificationCommands: Array<{ label: string; command: string }>;
  moduleRoots: string[];
  trackedFileCount?: number;
  trackedFileCountTruncated?: boolean;
  monorepo: boolean;
  unknowns: string[];
}

/**
 * Deterministic, evidence-only detection. Every field is either read straight from a manifest
 * (package.json "scripts", dependency names, lockfile presence) or derived by `git`; nothing is
 * guessed. `unknowns` lists what detection could not determine so the UI can show it honestly
 * instead of leaving a silent gap.
 */
export const detectProject = async (repositoryPath: string): Promise<ProjectDetection> => {
  const resolved = path.resolve(repositoryPath);
  const unknowns: string[] = [];
  if (!existsSync(resolved)) {
    return {
      repositoryPath: resolved,
      exists: false,
      git: { present: false },
      languages: [],
      frameworks: [],
      verificationCommands: [],
      moduleRoots: [],
      monorepo: false,
      unknowns: ["repository path does not exist on this machine"],
    };
  }
  const git = await detectGit(resolved);
  if (!git.present) unknowns.push("not a Git repository — MAF's worktree sandbox requires Git");

  const languages = new Set<string>();
  const frameworks = new Set<string>();
  let packageManager: string | undefined;
  const verificationCommands: Array<{ label: string; command: string }> = [];

  const manifest = await readJsonIfPresent(path.join(resolved, "package.json"));
  if (manifest) {
    languages.add("JavaScript/TypeScript");
    if (existsSync(path.join(resolved, "tsconfig.json"))) languages.add("TypeScript");
    const deps = {
      ...((manifest.dependencies as Record<string, string> | undefined) ?? {}),
      ...((manifest.devDependencies as Record<string, string> | undefined) ?? {}),
    };
    for (const [dependency, label] of Object.entries(frameworkByDependency)) {
      if (dependency in deps) frameworks.add(label);
    }
    if (existsSync(path.join(resolved, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (existsSync(path.join(resolved, "yarn.lock"))) packageManager = "yarn";
    else if (existsSync(path.join(resolved, "bun.lockb"))) packageManager = "bun";
    else if (existsSync(path.join(resolved, "package-lock.json"))) packageManager = "npm";
    const scripts = (manifest.scripts as Record<string, string> | undefined) ?? {};
    const scriptLabels: Record<string, string> = {
      test: "Kiểm thử",
      typecheck: "Kiểm tra kiểu",
      "type-check": "Kiểm tra kiểu",
      build: "Build",
      lint: "Lint",
    };
    for (const [script, label] of Object.entries(scriptLabels)) {
      if (typeof scripts[script] === "string") {
        verificationCommands.push({ label, command: `npm run ${script}` });
      }
    }
  } else {
    unknowns.push("no package.json found — Node/TypeScript scripts could not be read");
  }

  for (const { file, label } of ecosystemManifests) {
    if (existsSync(path.join(resolved, file))) languages.add(label);
  }
  if (languages.size === 0) unknowns.push("no recognized language manifest found");

  let moduleRoots: string[] = [];
  let trackedFileCount: number | undefined;
  let trackedFileCountTruncated: boolean | undefined;
  if (git.present) {
    try {
      const { LocalRepositoryIndex } = await import("./project-brain");
      const snapshot = await new LocalRepositoryIndex().index(resolved, git.revision ?? "HEAD");
      moduleRoots = snapshot.moduleRoots;
      trackedFileCount = snapshot.files.length;
      trackedFileCountTruncated = snapshot.filesTruncated;
    } catch {
      unknowns.push("could not enumerate tracked files (git ls-files failed)");
    }
  }

  return {
    repositoryPath: resolved,
    exists: true,
    git,
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    ...(packageManager ? { packageManager } : {}),
    verificationCommands,
    moduleRoots,
    ...(trackedFileCount !== undefined ? { trackedFileCount } : {}),
    ...(trackedFileCountTruncated !== undefined ? { trackedFileCountTruncated } : {}),
    monorepo: moduleRoots.length > 1,
    unknowns,
  };
};
