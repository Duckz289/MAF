// POST-FREEZE tag verification for the Scoring Runner.
//
// This is deliberately NOT a modification of evaluation/experiments/validate-manifest-v2.mjs. That
// validator is a historical PRE-freeze gate: it asserts `maf-experiment-protocol-v2` does NOT yet
// exist, which was correct while the freeze was still pending and is correct forever as a statement
// about the moment it guarded. Weakening it to accommodate scoring would retroactively destroy the
// evidence that the freeze had not happened when the manifest was validated.
//
// The scoring runner needs the exact opposite assertion -- every frozen tag MUST exist, locally and
// on the remote, and MUST peel to its expected commit -- so it gets its own gate here.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  INCIDENT_SHA,
  INCIDENT_TAG,
  PROTOCOL_V1_SHA,
  PROTOCOL_V1_TAG,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
  SUITE_SHA,
  SUITE_TAG,
} from "./frozen-refs";

const execFileAsync = promisify(execFile);

export interface TagExpectation {
  tag: string;
  expectedSha: string;
}

export type TagCheckStatus =
  | "OK"
  | "MISSING_LOCAL"
  | "MISSING_REMOTE"
  | "LOCAL_MISMATCH"
  | "REMOTE_MISMATCH"
  | "LOCAL_REMOTE_DIVERGED"
  | "CHECK_FAILED";

export interface TagCheckResult {
  tag: string;
  expectedSha: string;
  localSha: string | null;
  remoteSha: string | null;
  status: TagCheckStatus;
  detail: string;
}

export interface FrozenTagVerification {
  ok: boolean;
  checks: TagCheckResult[];
  failures: string[];
  /** True when remote verification was skipped because the caller asked for local-only checking. */
  remoteChecked: boolean;
}

export interface TagVerificationOptions {
  repoRoot: string;
  /**
   * Skip `git ls-remote`. Offline/local-only verification is honest about what it did NOT prove:
   * `remoteChecked` is false and the billed execution gate refuses to authorize on that basis.
   */
  skipRemote?: boolean;
  /** Injected for tests. Defaults to real git. */
  git?: (args: string[], cwd: string) => Promise<string>;
}

const realGit = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return stdout;
};

/** Resolves a tag to the COMMIT it peels to locally, or null when the tag does not exist. */
const localPeeled = async (
  git: NonNullable<TagVerificationOptions["git"]>,
  repoRoot: string,
  tag: string,
): Promise<string | null> => {
  try {
    const out = await git(["rev-parse", `refs/tags/${tag}^{commit}`], repoRoot);
    const sha = out.trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
};

/**
 * Resolves a tag to the commit it peels to ON THE REMOTE.
 *
 * An annotated tag publishes two refs: `refs/tags/<t>` (the tag object) and `refs/tags/<t>^{}` (the
 * commit it peels to). Only the peeled line proves which COMMIT the tag actually names, which is the
 * fact that matters -- comparing the tag-object SHA would silently accept a tag re-pointed at a
 * different commit.
 */
const remotePeeled = async (
  git: NonNullable<TagVerificationOptions["git"]>,
  repoRoot: string,
  tag: string,
): Promise<string | null> => {
  try {
    // NOTE: `--tags` combined with an exact pattern suppresses the peeled `^{}` line, which would
    // leave only the tag-object SHA -- precisely the value that must NOT be compared, since a tag
    // re-pointed at a different commit keeps its own object identity. Both refs are requested
    // explicitly instead. Args are passed as an array, so `^{}` reaches git uninterpreted.
    const out = await git(
      ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      repoRoot,
    );
    const lines = out
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
    if (peeled) return peeled.split(/\s+/u)[0] ?? null;
    // A lightweight tag has no peeled line; its single ref already names the commit.
    const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
    return direct ? (direct.split(/\s+/u)[0] ?? null) : null;
  } catch {
    return null;
  }
};

export const verifyFrozenTag = async (
  expectation: TagExpectation,
  options: TagVerificationOptions,
): Promise<TagCheckResult> => {
  const git = options.git ?? realGit;
  const { tag, expectedSha } = expectation;
  const localSha = await localPeeled(git, options.repoRoot, tag);
  const remoteSha = options.skipRemote ? null : await remotePeeled(git, options.repoRoot, tag);

  const base = { tag, expectedSha, localSha, remoteSha };

  if (localSha === null) {
    return {
      ...base,
      status: "MISSING_LOCAL",
      detail: `tag ${tag} does not exist locally; scoring requires the frozen tag to be present`,
    };
  }
  if (localSha !== expectedSha) {
    return {
      ...base,
      status: "LOCAL_MISMATCH",
      detail: `tag ${tag} peels locally to ${localSha}, expected ${expectedSha}; a moved frozen tag invalidates the freeze`,
    };
  }
  if (options.skipRemote) {
    return { ...base, status: "OK", detail: `tag ${tag} verified locally (remote check skipped)` };
  }
  if (remoteSha === null) {
    return {
      ...base,
      status: "MISSING_REMOTE",
      detail: `tag ${tag} is not published on origin; a local-only freeze is not durable evidence`,
    };
  }
  if (remoteSha !== expectedSha) {
    return {
      ...base,
      status: "REMOTE_MISMATCH",
      detail: `tag ${tag} peels on origin to ${remoteSha}, expected ${expectedSha}`,
    };
  }
  if (localSha !== remoteSha) {
    return {
      ...base,
      status: "LOCAL_REMOTE_DIVERGED",
      detail: `tag ${tag} peels locally to ${localSha} but to ${remoteSha} on origin`,
    };
  }
  return { ...base, status: "OK", detail: `tag ${tag} verified local == remote == ${expectedSha}` };
};

/**
 * The FIVE frozen artifacts every scoring action depends on: what was measured (suite), how it was
 * designed (protocol v1), how it is executed (protocol v2), how it will be analysed (analysis v1),
 * and why this runner exists at all (incident v1).
 *
 * The incident is a mandatory authority, not a footnote. Runner v2 is a direct consequence of
 * maf-scoring-incident-2026-09-03-v1, and a paid observation that cannot name the incident record
 * governing its own runner is not reproducible evidence -- so the same existence, peeled-SHA and
 * local==remote proof the other four require applies to it.
 */
export const FROZEN_TAG_EXPECTATIONS: readonly TagExpectation[] = [
  { tag: SUITE_TAG, expectedSha: SUITE_SHA },
  { tag: PROTOCOL_V1_TAG, expectedSha: PROTOCOL_V1_SHA },
  { tag: PROTOCOL_V2_TAG, expectedSha: PROTOCOL_V2_SHA },
  { tag: ANALYSIS_TAG, expectedSha: ANALYSIS_SHA },
  { tag: INCIDENT_TAG, expectedSha: INCIDENT_SHA },
];

/**
 * A single value naming WHICH frozen authorities a decision was reached under.
 *
 * Bound into every provider authorization so a capability minted against one frozen world cannot be
 * replayed in another. The runner tag's NAME is included (a campaign scored under a different
 * runner tag is a different campaign) but not its SHA, which is HEAD-dependent by design and
 * already proven separately by `verifyRunnerFreeze`.
 */
const digestAuthorities = (entries: ReadonlyArray<readonly [string, string]>): string => {
  const canonical = [...entries]
    .map(([tag, sha]) => `${tag}=${sha}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${RUNNER_TAG}\n${canonical}`).digest("hex");
};

/** The digest of the frozen authorities as this runner revision PINS them. */
export const canonicalFrozenAuthorityDigest = (): string =>
  digestAuthorities(FROZEN_TAG_EXPECTATIONS.map((e) => [e.tag, e.expectedSha] as const));

/**
 * The digest of the frozen authorities as they were ACTUALLY OBSERVED in the repository.
 *
 * Computed from the peeled commits verification really saw, so a world whose tags differ from the
 * pinned constants produces a different digest -- and the spawn boundary, which compares against
 * `canonicalFrozenAuthorityDigest()`, refuses rather than trusting the decision's own summary.
 */
export const observedFrozenAuthorityDigest = (checks: readonly TagCheckResult[]): string =>
  digestAuthorities(checks.map((check) => [check.tag, check.localSha ?? "ABSENT"] as const));

export const verifyFrozenArtifacts = async (
  options: TagVerificationOptions,
): Promise<FrozenTagVerification> => {
  const checks: TagCheckResult[] = [];
  for (const expectation of FROZEN_TAG_EXPECTATIONS) {
    checks.push(await verifyFrozenTag(expectation, options));
  }
  const failures = checks.filter((c) => c.status !== "OK").map((c) => c.detail);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    remoteChecked: options.skipRemote !== true,
  };
};

export interface WorktreeState {
  clean: boolean;
  headSha: string | null;
  dirtyPaths: string[];
  detail: string;
}

/** Working-tree cleanliness. A dirty tree means the executing source is not the tagged source. */
export const inspectWorktree = async (options: TagVerificationOptions): Promise<WorktreeState> => {
  const git = options.git ?? realGit;
  try {
    const headSha = (await git(["rev-parse", "HEAD"], options.repoRoot)).trim();
    const status = await git(["status", "--porcelain"], options.repoRoot);
    const dirtyPaths = status
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return {
      clean: dirtyPaths.length === 0,
      headSha: /^[0-9a-f]{40}$/u.test(headSha) ? headSha : null,
      dirtyPaths,
      detail:
        dirtyPaths.length === 0
          ? `worktree clean at ${headSha}`
          : `worktree has ${dirtyPaths.length} uncommitted change(s); the executing source is not a tagged revision`,
    };
  } catch (error) {
    return {
      clean: false,
      headSha: null,
      dirtyPaths: [],
      detail: `could not inspect worktree: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * Resolves the runner's own freeze tag LOCALLY only.
 *
 * Kept for non-billed inspection (the `validate` command's INFO line). It must never gate a paid
 * run on its own: a local tag proves nothing about what was published, and a runner freeze that
 * exists only on one machine is not durable evidence. Billed execution uses
 * `verifyRunnerFreeze` below.
 */
export const resolveRunnerTagSha = async (
  runnerTag: string,
  options: TagVerificationOptions,
): Promise<string | null> => localPeeled(options.git ?? realGit, options.repoRoot, runnerTag);

export type RunnerFreezeStatus =
  | "OK"
  | "MISSING_LOCAL"
  | "MISSING_REMOTE"
  | "LOCAL_REMOTE_DIVERGED"
  | "HEAD_MISMATCH"
  | "REMOTE_NOT_CHECKED"
  | "HEAD_UNRESOLVED";

export interface RunnerFreezeVerification {
  ok: boolean;
  status: RunnerFreezeStatus;
  runnerTag: string;
  localSha: string | null;
  remoteSha: string | null;
  headSha: string | null;
  remoteChecked: boolean;
  detail: string;
}

/**
 * Full runner-freeze verification for a billed run.
 *
 * Six facts must hold together, and the audit found the previous implementation established only
 * the first: the tag exists locally, exists on the remote, peels locally and remotely to the SAME
 * commit, and that commit is EXACTLY the source revision now executing. Comparing peeled commits
 * (never the annotated tag-object SHA) is what stops a tag re-pointed at a different commit from
 * passing, since re-pointing preserves neither the peeled commit nor, usefully, anything else.
 *
 * `skipRemote` is honoured for developer inspection but recorded as `REMOTE_NOT_CHECKED`, which is
 * never OK -- so a caller cannot accidentally buy a billed run with an unverified remote.
 */
export const verifyRunnerFreeze = async (input: {
  runnerTag: string;
  headSha: string | null;
  options: TagVerificationOptions;
}): Promise<RunnerFreezeVerification> => {
  const { runnerTag, headSha } = input;
  const git = input.options.git ?? realGit;
  const localSha = await localPeeled(git, input.options.repoRoot, runnerTag);
  const remoteChecked = input.options.skipRemote !== true;
  const remoteSha = remoteChecked
    ? await remotePeeled(git, input.options.repoRoot, runnerTag)
    : null;

  const base = { runnerTag, localSha, remoteSha, headSha, remoteChecked };

  if (localSha === null) {
    return {
      ...base,
      ok: false,
      status: "MISSING_LOCAL",
      detail:
        `runner tag ${runnerTag} does not exist locally. The scoring runner must be independently ` +
        "audited and frozen before it may spend money; until then billed scoring is refused.",
    };
  }
  if (!remoteChecked) {
    return {
      ...base,
      ok: false,
      status: "REMOTE_NOT_CHECKED",
      detail:
        `the remote was not consulted for ${runnerTag}. A local-only freeze is not durable ` +
        "evidence, so billed execution is refused regardless of the local tag.",
    };
  }
  if (remoteSha === null) {
    return {
      ...base,
      ok: false,
      status: "MISSING_REMOTE",
      detail: `runner tag ${runnerTag} is not published on origin; a local-only freeze is not durable evidence`,
    };
  }
  if (localSha !== remoteSha) {
    return {
      ...base,
      ok: false,
      status: "LOCAL_REMOTE_DIVERGED",
      detail: `runner tag ${runnerTag} peels locally to ${localSha} but to ${remoteSha} on origin`,
    };
  }
  if (headSha === null) {
    return {
      ...base,
      ok: false,
      status: "HEAD_UNRESOLVED",
      detail:
        "the executing source revision could not be resolved, so it cannot be compared to the runner tag",
    };
  }
  if (localSha !== headSha) {
    return {
      ...base,
      ok: false,
      status: "HEAD_MISMATCH",
      detail:
        `executing source ${headSha} is NOT the frozen runner revision ${localSha}; the audited ` +
        "revision and the spending revision must be the same commit",
    };
  }
  return {
    ...base,
    ok: true,
    status: "OK",
    detail: `runner tag ${runnerTag} verified local == remote == HEAD == ${localSha}`,
  };
};

// ------------------------------------------------------------ incident freeze

export type IncidentFreezeStatus =
  | "OK"
  | "MISSING_LOCAL"
  | "MISSING_REMOTE"
  | "LOCAL_MISMATCH"
  | "REMOTE_MISMATCH"
  | "LOCAL_REMOTE_DIVERGED"
  | "REMOTE_NOT_CHECKED";

export interface IncidentFreezeVerification {
  ok: boolean;
  status: IncidentFreezeStatus;
  incidentTag: string;
  expectedSha: string;
  localSha: string | null;
  remoteSha: string | null;
  remoteChecked: boolean;
  detail: string;
}

/**
 * Full incident-freeze verification, required before ANY paid Runner v2 execution.
 *
 * Runner v2 exists because of maf-scoring-incident-2026-09-03-v1. Treating that record as optional
 * would let a paid campaign be collected under a runner whose own justification could not be
 * produced -- so the incident tag is proven exactly as strictly as the suite and the protocol:
 * present locally, published on origin, and peeling on BOTH sides to the pinned commit.
 *
 * `skipRemote` is honoured for developer inspection but recorded as `REMOTE_NOT_CHECKED`, which is
 * never OK. A local-only incident record is not durable evidence, and the mission requires that a
 * skipped remote lookup refuse rather than quietly narrow what was proven.
 */
export const verifyIncidentFreeze = async (
  options: TagVerificationOptions,
): Promise<IncidentFreezeVerification> => {
  const git = options.git ?? realGit;
  const incidentTag = INCIDENT_TAG;
  const expectedSha = INCIDENT_SHA;
  const localSha = await localPeeled(git, options.repoRoot, incidentTag);
  const remoteChecked = options.skipRemote !== true;
  const remoteSha = remoteChecked ? await remotePeeled(git, options.repoRoot, incidentTag) : null;
  const base = { incidentTag, expectedSha, localSha, remoteSha, remoteChecked };

  if (localSha === null) {
    return {
      ...base,
      ok: false,
      status: "MISSING_LOCAL",
      detail:
        `incident tag ${incidentTag} does not exist locally. Paid Runner v2 execution requires the ` +
        "incident record that produced this runner to be a present, frozen authority.",
    };
  }
  if (localSha !== expectedSha) {
    return {
      ...base,
      ok: false,
      status: "LOCAL_MISMATCH",
      detail: `incident tag ${incidentTag} peels locally to ${localSha}, expected ${expectedSha}; a moved incident tag invalidates the record`,
    };
  }
  if (!remoteChecked) {
    return {
      ...base,
      ok: false,
      status: "REMOTE_NOT_CHECKED",
      detail:
        `the remote was not consulted for ${incidentTag}. A local-only incident record is not ` +
        "durable evidence, so billed execution is refused regardless of the local tag.",
    };
  }
  if (remoteSha === null) {
    return {
      ...base,
      ok: false,
      status: "MISSING_REMOTE",
      detail: `incident tag ${incidentTag} is not published on origin; a local-only incident record is not durable evidence`,
    };
  }
  if (remoteSha !== expectedSha) {
    return {
      ...base,
      ok: false,
      status: "REMOTE_MISMATCH",
      detail: `incident tag ${incidentTag} peels on origin to ${remoteSha}, expected ${expectedSha}`,
    };
  }
  if (localSha !== remoteSha) {
    return {
      ...base,
      ok: false,
      status: "LOCAL_REMOTE_DIVERGED",
      detail: `incident tag ${incidentTag} peels locally to ${localSha} but to ${remoteSha} on origin`,
    };
  }
  return {
    ...base,
    ok: true,
    status: "OK",
    detail: `incident tag ${incidentTag} verified local == remote == ${expectedSha}`,
  };
};
