import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sandbox, SandboxDiff } from "../domain/ports";

export interface VerificationMaterialization {
  rootPath: string;
  externalTempPath: string;
  candidateDigest?: string;
  bounded: boolean;
  operatorDependencyPaths: string[];
  dependencyManifestDigests: Array<{ path: string; digest: string }>;
  cleanup(): Promise<void>;
}

const digestBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const containedBy = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const safeManifestPath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  value !== ".git" &&
  !value.startsWith(".git/") &&
  !path.posix.isAbsolute(value) &&
  !/^[a-z]:\//iu.test(value) &&
  !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

const dependencyManifestPattern =
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|requirements(?:\.[^/]+)?\.txt|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/iu;

/**
 * High-confidence candidate-authored out-of-root reads. This is intentionally not called a jail:
 * the local process still runs on the host. It is a conservative guard for directly encoded
 * filesystem/module loads that would otherwise let uncaptured host bytes decide the result.
 */
const explicitOutOfRootRead = (bytes: Buffer): boolean => {
  if (bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  const loader = String.raw`(?:require|import|readFile|readFileSync|open|load|source)\s*(?:\(|)\s*["'\x60]`;
  const absolute = String.raw`(?:[a-z]:[\\/]|\\\\|/(?:Users|home|tmp|var/tmp|etc|opt|private)(?:/|\\))`;
  const traversal = String.raw`(?:\.\.[\\/]){1,}`;
  return new RegExp(`${loader}(?:${absolute}|${traversal})`, "iu").test(text);
};

const manifestDigest = (entries: NonNullable<SandboxDiff["candidateManifest"]>): string => {
  const digest = createHash("sha256");
  for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
    digest.update(`${entry.path}\0${entry.mode}\0${entry.digest}\0`);
  }
  return digest.digest("hex");
};

const existingDependencyRoots = async (sandbox: Sandbox): Promise<string[]> => {
  const candidates = [
    path.join(path.resolve(sandbox.path), "node_modules"),
    ...(sandbox.repositoryPath
      ? [path.join(path.resolve(sandbox.repositoryPath), "node_modules")]
      : []),
  ];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory() && !roots.includes(candidate))
        roots.push(candidate);
    } catch {
      // Operator dependencies are optional environment material.
    }
  }
  return roots;
};

export const materializeVerificationCandidate = async (
  sandbox: Sandbox,
  diff: SandboxDiff,
  _changedFiles: string[] = [],
): Promise<VerificationMaterialization> => {
  const entries = diff.candidateManifest;
  if (!diff.identityDigest || !entries || entries.length === 0) {
    const externalTempPath = await mkdtemp(path.join(tmpdir(), "maf-verification-legacy-temp-"));
    const operatorDependencyPaths = await existingDependencyRoots(sandbox);
    return {
      rootPath: sandbox.path,
      externalTempPath,
      ...(diff.identityDigest ? { candidateDigest: diff.identityDigest } : {}),
      bounded: false,
      operatorDependencyPaths,
      dependencyManifestDigests: [],
      cleanup: async () => {
        await rm(externalTempPath, { recursive: true, force: true });
      },
    };
  }
  if (manifestDigest(entries) !== diff.identityDigest) {
    throw new Error("captured candidate manifest does not match its candidate identity");
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("captured candidate manifest contains duplicate paths");
  }
  if (entries.some((entry) => !safeManifestPath(entry.path))) {
    throw new Error("captured candidate manifest contains an unsafe path");
  }
  const sourceRoot = await realpath(sandbox.path);
  const operatorDependencyPaths = await existingDependencyRoots(sandbox);
  const container = await mkdtemp(path.join(tmpdir(), "maf-verification-"));
  const rootPath = path.join(container, "candidate");
  const externalTempPath = path.join(container, "external-temp");
  await mkdir(rootPath, { recursive: true });
  await mkdir(externalTempPath, { recursive: true });

  try {
    for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
      const relative = entry.path.split("/").join(path.sep);
      const source = path.resolve(sourceRoot, relative);
      const destination = path.resolve(rootPath, relative);
      if (!containedBy(sourceRoot, source) || !containedBy(rootPath, destination)) {
        throw new Error(`candidate manifest path escaped materialization: ${entry.path}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      const sourceStat = await lstat(source);

      if (entry.mode === "120000") {
        if (!sourceStat.isSymbolicLink()) {
          throw new Error(`candidate symlink mode did not match workspace material: ${entry.path}`);
        }
        const targetText = await readlink(source);
        if (path.isAbsolute(targetText)) {
          throw new Error(`candidate symlink uses an absolute target: ${entry.path}`);
        }
        const resolvedTarget = await realpath(path.resolve(path.dirname(source), targetText));
        if (!containedBy(sourceRoot, resolvedTarget)) {
          throw new Error(`candidate symlink escapes the verification workspace: ${entry.path}`);
        }
        const linkBytes = Buffer.from(targetText, "utf8");
        if (digestBytes(linkBytes) !== entry.digest) {
          throw new Error(`candidate symlink changed after capture: ${entry.path}`);
        }
        const targetStat = await stat(resolvedTarget);
        await symlink(targetText, destination, targetStat.isDirectory() ? "dir" : "file");
        continue;
      }

      if (!sourceStat.isFile()) {
        throw new Error(`candidate entry is not a regular file: ${entry.path}`);
      }
      const bytes = await readFile(source);
      if (digestBytes(bytes) !== entry.digest) {
        throw new Error(`candidate file changed after capture: ${entry.path}`);
      }
      // The verifier can execute any captured candidate file, not only a file that changed in
      // this attempt. Guard every captured source so an unchanged helper cannot smuggle an
      // absolute or traversal-based host read into an otherwise clean candidate. `changed` is
      // retained for diagnostics/compatibility with older captures, but containment is a property
      // of the whole materialized candidate.
      if (explicitOutOfRootRead(bytes)) {
        throw new Error(
          `candidate contains an explicit out-of-root filesystem dependency: ${entry.path}`,
        );
      }
      await writeFile(destination, bytes);
      if (entry.mode === "100755" && process.platform !== "win32") {
        await chmod(destination, 0o755);
      }
    }

    return {
      rootPath,
      externalTempPath,
      candidateDigest: diff.identityDigest,
      bounded: true,
      operatorDependencyPaths,
      dependencyManifestDigests: entries
        .filter((entry) => dependencyManifestPattern.test(entry.path))
        .map((entry) => ({ path: entry.path, digest: entry.digest })),
      cleanup: async () => {
        await rm(container, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
};
