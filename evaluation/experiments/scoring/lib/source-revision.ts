// Immutable starting-state identity for a candidate workspace.
//
// The Protocol v2 preflight recorded `sourceRevision: "UNKNOWN"` for both arms even though the
// starting state was in fact fully determined: `ExperimentWorkspaceController` copies a pristine
// fixture tree and commits it. The information existed and was simply never captured. This module
// captures it two independent ways, without modifying the frozen workspace controller:
//
//   * contentDigest -- a deterministic hash over the fixture's file NAMES and CONTENTS. This is the
//     stronger identity: it is reproducible on any machine, independent of git, and it proves two
//     arms started from byte-identical material rather than merely from the same path.
//   * seedCommitSha -- the commit the controller creates inside the workspace. Useful for locating
//     the state in-place, but machine-local: git commit SHAs embed author/committer timestamps, so
//     the same content yields different SHAs on different runs. It is recorded as corroborating
//     evidence, never as the primary identity.
//
// Recording both means a later auditor can verify starting-state equality (content digest) AND
// reproduce what the participant actually saw (seed commit).

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CONTENT_DIGEST_NAMESPACE = "maf-scoring-fixture/v1";

export interface SourceRevisionIdentity {
  /** Deterministic hash of the pristine fixture tree. The primary, reproducible identity. */
  contentDigest: string;
  /** Number of files hashed, so an empty or partially-copied tree is obvious. */
  fileCount: number;
  /** Git commit created inside the workspace, when one exists. Machine-local corroboration. */
  seedCommitSha: string | null;
  /** How the identity was established, so a reader never has to guess. */
  method: "CONTENT_DIGEST_AND_SEED_COMMIT" | "CONTENT_DIGEST_ONLY";
  fixturePath: string;
}

/** Recursively lists files relative to `root`, sorted, so hashing order is deterministic. */
const listFilesRecursive = async (root: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  // Sort by name so traversal order never depends on filesystem enumeration order.
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    // `.git` is controller-created bookkeeping, not part of the task's starting content, and it
    // embeds timestamps that would make an otherwise identical tree hash differently.
    if (entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
};

/**
 * Hashes a fixture tree deterministically.
 *
 * The path is hashed alongside the content, and each is length-prefixed, so a file rename or a
 * content shift across a boundary cannot produce a colliding digest.
 */
export const computeContentDigest = async (
  fixturePath: string,
): Promise<{ digest: string; fileCount: number }> => {
  const files = await listFilesRecursive(fixturePath);
  const hash = createHash("sha256");
  hash.update(`${CONTENT_DIGEST_NAMESPACE}\n${files.length}\n`, "utf8");
  for (const relative of files) {
    const contents = await readFile(path.join(fixturePath, relative));
    hash.update(`path:${relative.length}:${relative}\n`, "utf8");
    hash.update(`size:${contents.length}\n`, "utf8");
    hash.update(contents);
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
};

/** Reads the seed commit a workspace was initialized with, when the workspace is a git repository. */
export const readSeedCommit = async (workspacePath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      encoding: "utf8",
      timeout: 15_000,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
};

export const captureSourceRevision = async (input: {
  fixturePath: string;
  workspacePath?: string;
}): Promise<SourceRevisionIdentity> => {
  const fixtureStat = await stat(input.fixturePath).catch(() => null);
  if (!fixtureStat?.isDirectory()) {
    throw new Error(`pristine fixture path is not a directory: ${input.fixturePath}`);
  }
  const { digest, fileCount } = await computeContentDigest(input.fixturePath);
  const seedCommitSha = input.workspacePath ? await readSeedCommit(input.workspacePath) : null;
  return {
    contentDigest: digest,
    fileCount,
    seedCommitSha,
    method: seedCommitSha === null ? "CONTENT_DIGEST_ONLY" : "CONTENT_DIGEST_AND_SEED_COMMIT",
    fixturePath: input.fixturePath,
  };
};

/**
 * Proves both arms of a paired run started from byte-identical material.
 *
 * A paired experiment where the arms began from different starting states is not measuring the
 * treatment; this makes that assumption checkable rather than assumed.
 */
export const assertStartingStateParity = (
  native: SourceRevisionIdentity,
  maf: SourceRevisionIdentity,
): void => {
  if (native.contentDigest !== maf.contentDigest) {
    throw new Error(
      "starting-state parity violated: NATIVE fixture digest " +
        `${native.contentDigest} != MAF fixture digest ${maf.contentDigest}. The arms did not ` +
        "begin from identical material, so any measured difference is confounded.",
    );
  }
  if (native.fileCount !== maf.fileCount) {
    throw new Error(
      `starting-state parity violated: NATIVE saw ${native.fileCount} files, MAF saw ${maf.fileCount}`,
    );
  }
};
