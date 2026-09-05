// STRUCTURAL PROVIDER ISOLATION -- the Runner v2 repair for incident
// maf-scoring-incident-2026-09-03-v1 (895797e0c58099c763e206b851ba144d287394db).
//
// WHAT WENT WRONG IN RUNNER v1
// ----------------------------
// `tests/scoring-freeze-simulation.test.ts` contained a case that drove the REAL production
// `execute` command against the REAL repository with `--confirm-billed-scoring`, and asserted that
// the RUNNER_FROZEN gate refuses. That assertion was true only while `maf-scoring-runner-v1` did
// not exist. Creating the tag -- the very ceremony the test existed to describe -- made every gate
// pass for real, and the command then resolved the operator's genuine first-party Claude Code
// executable through a PATH lookup and spent money on six frozen-suite runs.
//
// The defect was NOT a missing gate. Every gate worked exactly as designed. The defect was that
// ABSENT TEST CONFIGURATION FELL BACK TO THE REAL PROVIDER. Runner v1's safety for tests was a
// property of the outside world (a tag was absent) rather than a property of the code.
//
// THE RUNNER v2 RULE
// ------------------
// A provider may only be spawned by naming WHICH provider, explicitly, in a value that cannot be
// forged. There are exactly two such identities:
//
//   REAL_PROVIDER_EXECUTION        the operator's real first-party Claude Code CLI
//   TEST_DOUBLE_PROVIDER_EXECUTION an approved fake executable from a test-controlled fixture
//
// There is no third state and, critically, no default. Supplying nothing does not yield the real
// provider; it yields a refusal. That inverts the incident's failure direction: the unconfigured
// path is now the safe one.
//
// WHAT THE INDEPENDENT AUDIT CHANGED (repairs 1, 4 and 7)
// ------------------------------------------------------
// The first v2 revision made `ProviderIdentity` unforgeable with a `declare const BRAND` symbol.
// That is a COMPILE-TIME construct, erased entirely at runtime, so the lowest boundary accepted a
// hand-written object literal that had merely been cast. Three consequences, all now fixed:
//
//   * authenticity is a module-private `WeakSet` registration (`AUTHENTIC_PROVIDER_IDENTITIES`),
//     so a literal, a spread, an `Object.assign` clone and a JSON round-trip are all refused --
//     each produces a DIFFERENT object, and only the exact objects the factories built are members;
//   * the execution context is no longer sniffed from the environment on every call. It is an
//     explicitly constructed, separately authenticated value (see `execution-context.ts`), carried
//     BY the identity, so a stale or forged classification cannot travel with a capability;
//   * test-double containment is resolved through `realpath` before anything is read or compared,
//     so a symlink or a Windows junction cannot alias a file outside the declared fixture root into
//     apparent containment.
//
// Nothing here exposes a registration primitive. There is no `registerIdentity(obj)`, no exported
// set, and no factory that accepts a caller-built object and blesses it: the only members of the
// registry are objects these two constructors built from validated inputs.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertAuthenticExecutionContext,
  assertNoAmbientContradiction,
  ambientContradiction,
  isAuthenticExecutionContext,
  type ExecutionContext,
} from "./execution-context";

export type { ExecutionContext, ExecutionContextKind } from "./execution-context";

/** Kind of provider a scoring spawn is bound to. Mutually exclusive by construction. */
export type ProviderIdentityKind = "REAL_PROVIDER_EXECUTION" | "TEST_DOUBLE_PROVIDER_EXECUTION";

/**
 * The token an approved test double must carry INSIDE ITS OWN FILE CONTENT.
 *
 * Content-based identification rather than a naming convention or a path prefix: a real Claude Code
 * binary can be copied, renamed, symlinked or placed under any directory a test chooses, but it
 * cannot come to contain this string. Executable identity is therefore established, not assumed.
 * The bytes are read from the REALPATH-resolved file, so a marker "in the path" proves nothing.
 */
export const TEST_DOUBLE_MARKER = "MAF_SCORING_TEST_DOUBLE_PROVIDER_V2";

/**
 * Filename declaring a directory as a test-controlled provider fixture root.
 *
 * The approved executable must sit inside a directory tree carrying this file. A test's temporary
 * fixture directory creates one; the operator's real Claude installation directory never will.
 */
export const TEST_DOUBLE_ROOT_MARKER_FILE = ".maf-test-double-provider";

/** How far up from the resolved executable an ancestor root marker is honoured. */
const ROOT_MARKER_SEARCH_DEPTH = 6;

/**
 * Basenames that name a real first-party Claude Code CLI.
 *
 * Checked against BOTH the supplied path and the realpath-resolved path, so a fixture-looking name
 * that resolves to `claude.exe` is reported for the right reason.
 */
const REAL_CLAUDE_BASENAMES: readonly string[] = [
  "claude",
  "claude.exe",
  "claude.cmd",
  "claude.bat",
  "claude.ps1",
  "claude-code",
  "claude-code.exe",
];

// --------------------------------------------------------- canonical paths

/**
 * Resolves a path through symlinks, junctions and `..` to its canonical on-disk location.
 *
 * Returns null when the path does not exist or cannot be resolved -- which is a refusal, never a
 * fallback to the unresolved string.
 */
const canonicalPath = async (candidate: string): Promise<string | null> => {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
};

/**
 * Case- and separator-normalised form for containment comparison.
 *
 * Windows needs case folding (`C:\Fixtures` and `c:\fixtures` are one directory) and drive-letter
 * normalisation; `path.resolve` supplies the latter and settles separators on both platforms.
 */
const normalizeForCompare = (candidate: string): string =>
  process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);

/**
 * Strict containment of an already-canonical child within an already-canonical root.
 *
 * `path.relative` is the load-bearing part: a sibling yields a `..`-prefixed result, and a path on
 * another Windows drive yields an ABSOLUTE result, so both are rejected. Equality is rejected too --
 * the root directory is not itself an executable.
 */
export const isContainedWithin = (child: string, root: string): boolean => {
  const normalizedChild = normalizeForCompare(child);
  const normalizedRoot = normalizeForCompare(root);
  if (normalizedChild === normalizedRoot) return false;
  const relative = path.relative(normalizedRoot, normalizedChild);
  if (relative.length === 0) return false;
  if (path.isAbsolute(relative)) return false;
  return !relative.split(/[\\/]/u).includes("..");
};

// --------------------------------------------------------- provider identity

/**
 * Module-private compile-time brand, kept only so a `ProviderIdentity` cannot be produced by
 * structural typing without a deliberate cast. It is NOT the security mechanism -- the WeakSet
 * below is. The audit's finding was precisely that this brand, alone, is erased at runtime.
 */
declare const PROVIDER_IDENTITY_BRAND: unique symbol;

export interface ProviderIdentity {
  readonly [PROVIDER_IDENTITY_BRAND]: true;
  readonly kind: ProviderIdentityKind;
  /** The exact absolute executable this identity authorizes. Compared verbatim at spawn time. */
  readonly executablePath: string;
  /** The realpath-resolved executable. For a test double this is what the marker was read from. */
  readonly resolvedExecutablePath: string;
  /** For a test double, the canonical test-controlled root the executable was proven to sit in. */
  readonly testDoubleRoot: string | null;
  /**
   * The AUTHENTIC execution context this identity was established in.
   *
   * Carried by object reference, not by kind string, so the spawn boundary can require the very
   * same context object rather than a value that merely claims the same classification.
   */
  readonly context: ExecutionContext;
  readonly detail: string;
}

/**
 * THE RUNTIME AUTHENTICITY REGISTRY.
 *
 * Module-private; never exported, never handed out, never fed a caller-supplied object. Only the
 * two constructors below add to it, and each adds the exact object it just built from validated
 * inputs. Membership therefore answers "did this module make you?", which is the question the
 * erased TypeScript brand could not.
 */
const AUTHENTIC_PROVIDER_IDENTITIES = new WeakSet<object>();

export type ProviderIdentityOutcome =
  | { approved: true; identity: ProviderIdentity }
  | { approved: false; reason: ProviderIdentityRefusal; detail: string };

export type ProviderIdentityRefusal =
  | "NO_EXECUTABLE_SUPPLIED"
  | "NOT_ABSOLUTE"
  | "NOT_A_FILE"
  | "UNRESOLVABLE_PATH"
  | "UNREADABLE"
  | "REAL_CLAUDE_EXECUTABLE"
  | "MARKER_ABSENT"
  | "ROOT_MARKER_ABSENT"
  | "ROOT_ESCAPE"
  | "TEST_DOUBLE_IN_PRODUCTION_PATH"
  | "CONTEXT_NOT_AUTHENTIC"
  | "CONTEXT_KIND_MISMATCH"
  | "AMBIENT_CONTRADICTION"
  | "TEST_CONTEXT_REQUIRES_TEST_DOUBLE";

const refuse = (
  reason: ProviderIdentityRefusal,
  detail: string,
): { approved: false; reason: ProviderIdentityRefusal; detail: string } => ({
  approved: false,
  reason,
  detail,
});

/** Walks up from the RESOLVED executable looking for the directory marker declaring a test root. */
const findTestDoubleRoot = async (resolvedExecutable: string): Promise<string | null> => {
  let dir = path.dirname(resolvedExecutable);
  for (let depth = 0; depth < ROOT_MARKER_SEARCH_DEPTH; depth += 1) {
    const marker = path.join(dir, TEST_DOUBLE_ROOT_MARKER_FILE);
    const found = await stat(marker)
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (found) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/**
 * Approves an explicitly-supplied fake executable as a TEST_DOUBLE provider.
 *
 * EVERY condition must hold; there is no partial approval and no "close enough":
 *
 *   - the execution context is AUTHENTIC and is TEST
 *   - a path was supplied at all           (absence is a refusal, never a fallback to `claude`)
 *   - the path is ABSOLUTE                 (a bare name would be resolved through PATH at spawn)
 *   - the path RESOLVES (realpath) to a real, readable file
 *   - neither the supplied nor the resolved basename names the real Claude CLI
 *   - the RESOLVED file's CONTENT carries TEST_DOUBLE_MARKER
 *   - an ancestor of the RESOLVED file declares itself a test-controlled fixture root
 *   - the RESOLVED file is contained within the RESOLVED root
 *
 * The realpath steps are what close the audit's containment finding. Resolving first means a
 * symlink or junction that aliases an outside file into a fixture directory is walked to its real
 * location, where no root marker exists -- so the alias buys nothing. It also means the marker bytes
 * are read from the file that would actually execute, not from the name used to reach it.
 *
 * Note the deliberate absence of any PATH lookup: this function never searches or guesses. It only
 * inspects the exact bytes at the exact resolved path.
 */
export const approveTestDoubleProvider = async (input: {
  executablePath: string | undefined;
  context: unknown;
  /** Injected for tests of this module itself; defaults to real filesystem reads. */
  readFileText?: (filePath: string) => Promise<string>;
}): Promise<ProviderIdentityOutcome> => {
  const context = input.context;
  if (!isAuthenticExecutionContext(context)) {
    return refuse(
      "CONTEXT_NOT_AUTHENTIC",
      "the execution context supplied to test-double approval was not constructed by this " +
        'process. A plain object such as { kind: "TEST" } is refused: context authenticity is a ' +
        "runtime registration, so a literal, a clone and a JSON round-trip all fail it.",
    );
  }
  if (context.kind !== "TEST") {
    return refuse(
      "CONTEXT_KIND_MISMATCH",
      `a TEST_DOUBLE provider was requested under a ${context.kind} execution context. Simulated ` +
        "observations must never be recorded as paid scoring evidence.",
    );
  }

  const supplied = input.executablePath;
  if (!supplied || supplied.trim().length === 0) {
    return refuse(
      "NO_EXECUTABLE_SUPPLIED",
      "no test-double provider executable was supplied. A scoring test may not fall back to a " +
        "resolved `claude`, to PATH, or to the operator's pinned real executable: the absence of " +
        "test provider configuration is a refusal, not a default. This is the exact fallback that " +
        "produced incident maf-scoring-incident-2026-09-03-v1.",
    );
  }
  if (!path.isAbsolute(supplied)) {
    return refuse(
      "NOT_ABSOLUTE",
      `test-double provider "${supplied}" is not an absolute path, so the spawn would perform its ` +
        "own PATH lookup and could reach the real Claude Code CLI.",
    );
  }
  if (REAL_CLAUDE_BASENAMES.includes(path.basename(supplied).toLowerCase())) {
    return refuse(
      "REAL_CLAUDE_EXECUTABLE",
      `test-double provider "${supplied}" names a real first-party Claude Code executable. A test ` +
        "may never spawn the real provider, however complete its other configuration is.",
    );
  }

  // CANONICALISATION FIRST. Everything below reasons about the file that would really execute.
  const resolved = await canonicalPath(supplied);
  if (resolved === null) {
    return refuse(
      "UNRESOLVABLE_PATH",
      `test-double provider "${supplied}" could not be resolved to a canonical filesystem path, ` +
        "so neither its identity nor its containment can be established. An unresolvable path is " +
        "refused rather than compared as a bare string.",
    );
  }
  if (REAL_CLAUDE_BASENAMES.includes(path.basename(resolved).toLowerCase())) {
    return refuse(
      "REAL_CLAUDE_EXECUTABLE",
      `test-double provider "${supplied}" resolves to "${resolved}", which names a real ` +
        "first-party Claude Code executable. A link with a harmless name does not change what " +
        "would be spawned.",
    );
  }

  const isFile = await stat(resolved)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!isFile) {
    return refuse(
      "NOT_A_FILE",
      `test-double provider "${supplied}" (resolved: "${resolved}") does not name an existing ` +
        "file, so its identity as a test double cannot be established.",
    );
  }

  const read = input.readFileText ?? ((filePath: string) => readFile(filePath, "utf8"));
  let content: string;
  try {
    // Read from the RESOLVED path: the marker must be in the bytes that would run, and a marker in
    // a filename or a directory name is not evidence of anything.
    content = await read(resolved);
  } catch (error) {
    return refuse(
      "UNREADABLE",
      `test-double provider "${resolved}" could not be read, so its identity as a test double ` +
        `cannot be established: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!content.includes(TEST_DOUBLE_MARKER)) {
    return refuse(
      "MARKER_ABSENT",
      `test-double provider "${resolved}" does not carry the ${TEST_DOUBLE_MARKER} marker in its ` +
        "own bytes. A real provider binary cannot contain it, so its absence means the " +
        "executable's identity as a test double is unproven -- which is refused rather than assumed.",
    );
  }

  const rootMarkerDir = await findTestDoubleRoot(resolved);
  if (rootMarkerDir === null) {
    return refuse(
      "ROOT_MARKER_ABSENT",
      `test-double provider "${resolved}" is not inside a directory tree declared as a ` +
        `test-controlled provider fixture root (no ${TEST_DOUBLE_ROOT_MARKER_FILE} within ` +
        `${ROOT_MARKER_SEARCH_DEPTH} parent directories of its CANONICAL location). A symlink or ` +
        "junction from inside a fixture root does not place a file inside that root.",
    );
  }

  // Explicit containment on canonical paths. The walk above started from the resolved executable,
  // so this can only fail in exotic cases -- which is exactly why it is asserted rather than assumed.
  const resolvedRoot = await canonicalPath(rootMarkerDir);
  if (resolvedRoot === null || !isContainedWithin(resolved, resolvedRoot)) {
    return refuse(
      "ROOT_ESCAPE",
      `test-double provider "${resolved}" is not contained within the canonical fixture root ` +
        `"${resolvedRoot ?? rootMarkerDir}". Containment is decided on realpath-resolved, ` +
        "case-normalised paths, so an alias that only looks contained is refused.",
    );
  }

  const identity: ProviderIdentity = Object.freeze({
    kind: "TEST_DOUBLE_PROVIDER_EXECUTION",
    executablePath: supplied,
    resolvedExecutablePath: resolved,
    testDoubleRoot: resolvedRoot,
    context,
    detail:
      `approved TEST_DOUBLE provider ${supplied} (canonical ${resolved}; marker verified in file ` +
      `content; contained in canonical fixture root ${resolvedRoot})`,
  }) as ProviderIdentity;
  AUTHENTIC_PROVIDER_IDENTITIES.add(identity);
  return { approved: true, identity };
};

/**
 * Establishes a REAL_PROVIDER_EXECUTION identity for the operator's pinned Claude Code executable.
 *
 * Refuses outright unless the execution context is authentic AND PRODUCTION, and refuses again if
 * that PRODUCTION claim contradicts a plainly-visible test harness. Real-provider identity is not
 * something a test can obtain by having every other gate pass: in the incident every gate DID pass
 * -- freeze, auth, budget, config, billed confirmation -- and this constructor is what refuses anyway.
 */
export const resolveRealProviderIdentity = (input: {
  executablePath: string | null | undefined;
  context: unknown;
  /** Content of the executable when known, so a mislabelled test double is caught here too. */
  markerObserved?: boolean;
  /** Injected so a test can assert the contradiction rule without mutating its own environment. */
  environment?: NodeJS.ProcessEnv;
}): ProviderIdentityOutcome => {
  const context = input.context;
  if (!isAuthenticExecutionContext(context)) {
    return refuse(
      "CONTEXT_NOT_AUTHENTIC",
      "the execution context supplied for REAL_PROVIDER_EXECUTION was not constructed by this " +
        "process. Only createProductionExecutionContext() yields one, and no environment variable " +
        "or hand-written object can stand in for it.",
    );
  }
  if (context.kind === "TEST") {
    return refuse(
      "TEST_CONTEXT_REQUIRES_TEST_DOUBLE",
      "REAL_PROVIDER_EXECUTION was requested from a TEST execution context " +
        `(origin ${context.origin}). A test may only spawn an approved TEST_DOUBLE, regardless of ` +
        "freeze state, billed confirmation, or how many gates passed. This is the structural " +
        "interlock for incident maf-scoring-incident-2026-09-03-v1.",
    );
  }
  const contradiction = ambientContradiction(context, input.environment ?? process.env);
  if (contradiction) return refuse("AMBIENT_CONTRADICTION", contradiction);

  const supplied = input.executablePath;
  if (!supplied || supplied.trim().length === 0) {
    return refuse("NO_EXECUTABLE_SUPPLIED", "no participant executable was pinned.");
  }
  if (!path.isAbsolute(supplied)) {
    return refuse(
      "NOT_ABSOLUTE",
      `participant executable "${supplied}" is not absolute, so each spawn would repeat a PATH ` +
        "lookup that could resolve to a different binary.",
    );
  }
  if (input.markerObserved === true) {
    return refuse(
      "TEST_DOUBLE_IN_PRODUCTION_PATH",
      `participant executable "${supplied}" carries the ${TEST_DOUBLE_MARKER} marker, so it is a ` +
        "test double being presented as the real provider. Billed scoring must not record " +
        "simulated observations as paid evidence.",
    );
  }

  const identity: ProviderIdentity = Object.freeze({
    kind: "REAL_PROVIDER_EXECUTION",
    executablePath: supplied,
    resolvedExecutablePath: supplied,
    testDoubleRoot: null,
    context,
    detail: `REAL_PROVIDER_EXECUTION pinned to ${supplied} in a PRODUCTION context`,
  }) as ProviderIdentity;
  AUTHENTIC_PROVIDER_IDENTITIES.add(identity);
  return { approved: true, identity };
};

/** Runtime authenticity predicate. Reading membership is safe to export; adding is not. */
export const isAuthenticProviderIdentity = (value: unknown): value is ProviderIdentity =>
  typeof value === "object" && value !== null && AUTHENTIC_PROVIDER_IDENTITIES.has(value);

// ------------------------------------------------------------- spawn interlock

/**
 * THE LOWEST PRACTICAL PROVIDER BOUNDARY.
 *
 * Called immediately before a participant executor is constructed, with the executable that is
 * genuinely about to be spawned. Every one of the following must hold; the first failure throws.
 *
 *   1. the execution context is AUTHENTIC                (not a `{ kind: "TEST" }` literal)
 *   2. the PRODUCTION claim does not contradict the live environment
 *   3. the provider identity is AUTHENTIC                (not a literal, clone or JSON round-trip)
 *   4. the identity was minted in EXACTLY this context   (object identity, not a matching string)
 *   5. TEST admits only TEST_DOUBLE; PRODUCTION admits only REAL_PROVIDER
 *   6. the executable is present and absolute
 *   7. the identity's executable is the one about to be spawned, verbatim
 *
 * Throws -- never returns a boolean. A caller that forgets to check a return value is a bug that
 * spends money; a caller that forgets to catch an exception is a bug that refuses.
 */
export const assertProviderIdentityForSpawn = (
  identity: ProviderIdentity | undefined,
  context: {
    executablePath: string | undefined;
    /** REQUIRED and authenticated. There is no default and no environment sniff to fall back on. */
    executionContext: unknown;
    /** Injected so a test can drive the contradiction rule deterministically. */
    environment?: NodeJS.ProcessEnv;
  },
): void => {
  // 1 + 2. The world this spawn happens in, proven before anything about the provider is read.
  assertAuthenticExecutionContext(context.executionContext, "the provider spawn boundary");
  const observed = context.executionContext;
  assertNoAmbientContradiction(observed, context.environment ?? process.env);

  if (!identity) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: no provider identity was supplied to the spawn boundary. Every " +
        "scoring spawn must name REAL_PROVIDER_EXECUTION or TEST_DOUBLE_PROVIDER_EXECUTION " +
        "explicitly; there is no default and no fallback to a resolved `claude`.",
    );
  }

  // 3. Runtime authenticity. This is the check the erased TypeScript brand could not perform, and
  //    the one the audit found missing: a plain object that merely LOOKS like an identity reaches
  //    here routinely in an attack, and dies here.
  if (!isAuthenticProviderIdentity(identity)) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the provider identity presented at the spawn boundary was not " +
        "created by the provider-identity factories. A hand-written object, an object spread, an " +
        "Object.assign clone and a JSON round-trip all produce a DIFFERENT object and are all " +
        "refused. Only approveTestDoubleProvider() and resolveRealProviderIdentity() can mint one.",
    );
  }

  // 4. The identity must belong to THIS context, by object reference. A capability minted earlier,
  //    elsewhere, or under a different classification cannot be presented here.
  if (identity.context !== observed) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: provider identity ${identity.kind} was established in a ` +
        `different execution context (${identity.context.kind}, origin ` +
        `${identity.context.origin}) than the one presented at the spawn boundary ` +
        `(${observed.kind}, origin ${observed.origin}). A capability may not be carried across ` +
        "execution contexts.",
    );
  }

  // 5. The interlock. Stated after authenticity because a forged value must never reach it, and
  //    before every binding below because it holds even when they are all perfect.
  if (observed.kind === "TEST" && identity.kind !== "TEST_DOUBLE_PROVIDER_EXECUTION") {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the spawn boundary was reached in a TEST execution context " +
        `(origin ${observed.origin}) with provider identity ${identity.kind}. Only an approved ` +
        "TEST_DOUBLE may be spawned under test, whatever the freeze state, the billed " +
        "confirmation, or the gate results say.",
    );
  }
  if (observed.kind === "PRODUCTION" && identity.kind === "TEST_DOUBLE_PROVIDER_EXECUTION") {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: a TEST_DOUBLE provider identity reached a PRODUCTION execution " +
        "context. Simulated observations must never be recorded as paid scoring evidence.",
    );
  }

  // 6 + 7. The exact binary.
  if (context.executablePath === undefined || context.executablePath === "") {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the spawn boundary was reached without an executable, so the " +
        "adapter would fall back to its own `claude` default and perform a PATH lookup.",
    );
  }
  if (!path.isAbsolute(context.executablePath)) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: participant executable "${context.executablePath}" is not ` +
        "absolute; every spawn must name an exact binary rather than repeat a PATH lookup.",
    );
  }
  if (identity.executablePath !== context.executablePath) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: provider identity ${identity.kind} was established for ` +
        `"${identity.executablePath}" but the spawn would launch "${context.executablePath}".`,
    );
  }
};

/**
 * Cheap, bounded check for the test-double marker in a candidate REAL provider executable.
 *
 * Reads at most the first 256 KiB of the REALPATH-resolved file. A test double is a small script and
 * carries the marker well inside that window; a real Claude Code binary is far larger and contains
 * it nowhere. Bounding the read keeps the production path from slurping a multi-megabyte executable
 * on every invocation while still catching a simulated binary passed off as the real provider.
 */
export const observeTestDoubleMarker = async (
  executablePath: string,
  readHead: (filePath: string, bytes: number) => Promise<string> = async (filePath, bytes) => {
    const { open } = await import("node:fs/promises");
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("latin1");
    } finally {
      await handle.close();
    }
  },
): Promise<boolean> => {
  try {
    const resolved = (await canonicalPath(executablePath)) ?? executablePath;
    return (await readHead(resolved, 256 * 1024)).includes(TEST_DOUBLE_MARKER);
  } catch {
    // Unreadable is not evidence of being a test double; the REAL identity path has its own
    // absolute-path and context requirements, and the executable gate probes it separately.
    return false;
  }
};

/** Human-readable one-liner for gate output. */
export const describeProviderIdentity = (identity: ProviderIdentity | null): string =>
  identity === null ? "NONE" : `${identity.kind} -> ${identity.executablePath}`;
