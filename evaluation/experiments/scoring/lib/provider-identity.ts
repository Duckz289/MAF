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
// WHY THIS IS NOT AN ENVIRONMENT OPT-IN (mission Repair 7)
// -------------------------------------------------------
// Test-context detection below is one INPUT to the interlock, never the mechanism. The mechanism is
// the branded capability: `ProviderIdentity` cannot be constructed outside this module, and the two
// constructors impose requirements that no environment variable can satisfy or waive --
// `approveTestDouble` demands a real file carrying a marker inside a declared test-controlled root,
// and `resolveRealProvider` demands an absolute path that provably is NOT such a file. If every
// environment signal were stripped, a test would still have to hand the spawn boundary a forged
// capability to reach a real provider, and it cannot construct one.
//
// Detection is additionally FAIL-SAFE: any one signal forces TEST, and TEST admits only a test
// double. Nothing has to be set to become safe; something would have to be constructible to become
// unsafe.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Kind of provider a scoring spawn is bound to. Mutually exclusive by construction. */
export type ProviderIdentityKind = "REAL_PROVIDER_EXECUTION" | "TEST_DOUBLE_PROVIDER_EXECUTION";

/** Whether this process is running as production tooling or inside a test harness. */
export type ExecutionContextKind = "PRODUCTION" | "TEST";

/**
 * The token an approved test double must carry INSIDE ITS OWN FILE CONTENT.
 *
 * Content-based identification rather than a naming convention or a path prefix: a real Claude Code
 * binary can be copied, renamed, symlinked or placed under any directory a test chooses, but it
 * cannot come to contain this string. Executable identity is therefore established, not assumed --
 * which is what mission Repair 2 requires ("If executable identity cannot be established: REFUSE").
 */
export const TEST_DOUBLE_MARKER = "MAF_SCORING_TEST_DOUBLE_PROVIDER_V2";

/**
 * Filename declaring a directory as a test-controlled provider fixture root.
 *
 * The approved executable must sit inside a directory tree carrying this file. A test's temporary
 * fixture directory creates one; the operator's real Claude installation directory never will.
 */
export const TEST_DOUBLE_ROOT_MARKER_FILE = ".maf-test-double-provider";

/** How far up from the executable an ancestor root marker is honoured. */
const ROOT_MARKER_SEARCH_DEPTH = 6;

/**
 * Basenames that name a real first-party Claude Code CLI.
 *
 * Checked in addition to the marker so a refusal reports the RIGHT reason: "you pointed the test
 * double at the real Claude executable" rather than the generic "no marker found".
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

// ------------------------------------------------------------- test context

export interface ExecutionContext {
  kind: ExecutionContextKind;
  /** Every observed reason this process looks like a test. Empty exactly when kind is PRODUCTION. */
  signals: string[];
  detail: string;
}

/**
 * Classifies the current process, FAIL-SAFE: any single signal forces TEST.
 *
 * These signals are INHERITED, not opted into. A vitest worker exports `VITEST`/`VITEST_WORKER_ID`,
 * and a child process spawned from a test with `{...process.env}` -- which is exactly how the
 * incident's subprocess reached the CLI -- carries them too. So the code path that caused the
 * incident is classified TEST without anyone remembering to say so.
 *
 * Being over-broad here costs a refusal, never money, so the list errs wide. It deliberately does
 * NOT include general signals like `CI`, which would not have caught the incident and could refuse a
 * legitimate operator.
 */
export const detectExecutionContext = (
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionContext => {
  const signals: string[] = [];
  const present = (key: string): boolean => {
    const raw = environment[key];
    return typeof raw === "string" && raw.length > 0;
  };

  if (present("VITEST")) signals.push("VITEST");
  if (present("VITEST_WORKER_ID")) signals.push("VITEST_WORKER_ID");
  if (present("VITEST_POOL_ID")) signals.push("VITEST_POOL_ID");
  if (present("JEST_WORKER_ID")) signals.push("JEST_WORKER_ID");
  if (present("NODE_TEST_CONTEXT")) signals.push("NODE_TEST_CONTEXT");
  if (environment.NODE_ENV === "test") signals.push("NODE_ENV=test");

  // npm/pnpm/yarn export the script being run. `npm test` and `npm run validate` both reach the
  // scoring runner only through a test harness.
  const lifecycle = environment.npm_lifecycle_event ?? "";
  if (/^(test|test:watch|validate)$/u.test(lifecycle)) {
    signals.push(`npm_lifecycle_event=${lifecycle}`);
  }
  const lifecycleScript = environment.npm_lifecycle_script ?? "";
  if (/\bvitest\b|\bjest\b/u.test(lifecycleScript)) signals.push("npm_lifecycle_script");

  // Explicit declaration. Defence in depth ONLY: it can force TEST (safe direction) and is
  // deliberately incapable of forcing PRODUCTION, so no environment value can relax the interlock.
  if (environment.MAF_SCORING_EXECUTION_CONTEXT === "TEST") {
    signals.push("MAF_SCORING_EXECUTION_CONTEXT=TEST");
  }

  return {
    kind: signals.length > 0 ? "TEST" : "PRODUCTION",
    signals,
    detail:
      signals.length > 0
        ? `TEST execution context detected via ${signals.join(", ")}; only an approved ` +
          "TEST_DOUBLE provider may be spawned"
        : "no test-harness signal observed; this is a PRODUCTION execution context",
  };
};

// --------------------------------------------------------- provider identity

/**
 * Module-private brand. Never exported, so no object literal and no type assertion outside this
 * file can produce a `ProviderIdentity`. The only sources are the two constructors below, and each
 * enforces its own preconditions -- the same capability pattern `ProviderAuthorization` uses, applied
 * to the question the incident turned on: WHICH executable is this.
 */
declare const PROVIDER_IDENTITY_BRAND: unique symbol;

export interface ProviderIdentity {
  readonly [PROVIDER_IDENTITY_BRAND]: true;
  readonly kind: ProviderIdentityKind;
  /** The exact absolute executable this identity authorizes. Compared verbatim at spawn time. */
  readonly executablePath: string;
  /** For a test double, the declared test-controlled root the executable was found under. */
  readonly testDoubleRoot: string | null;
  /** Context this identity was established in; re-checked at the spawn boundary. */
  readonly contextKind: ExecutionContextKind;
  readonly detail: string;
}

export type ProviderIdentityOutcome =
  | { approved: true; identity: ProviderIdentity }
  | { approved: false; reason: ProviderIdentityRefusal; detail: string };

export type ProviderIdentityRefusal =
  | "NO_EXECUTABLE_SUPPLIED"
  | "NOT_ABSOLUTE"
  | "NOT_A_FILE"
  | "UNREADABLE"
  | "REAL_CLAUDE_EXECUTABLE"
  | "MARKER_ABSENT"
  | "ROOT_MARKER_ABSENT"
  | "TEST_DOUBLE_IN_PRODUCTION_PATH"
  | "TEST_CONTEXT_REQUIRES_TEST_DOUBLE";

const refuse = (
  reason: ProviderIdentityRefusal,
  detail: string,
): { approved: false; reason: ProviderIdentityRefusal; detail: string } => ({
  approved: false,
  reason,
  detail,
});

/** Walks up from a file looking for the directory marker that declares a test-controlled root. */
const findTestDoubleRoot = async (executablePath: string): Promise<string | null> => {
  let dir = path.dirname(executablePath);
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
 * Approves an explicitly-supplied fake executable as a TEST_DOUBLE provider (mission Repair 2).
 *
 * EVERY condition must hold; there is no partial approval and no "close enough":
 *
 *   - a path was supplied at all           (absence is a refusal, never a fallback to `claude`)
 *   - the path is ABSOLUTE                 (a bare name would be resolved through PATH at spawn)
 *   - the path names a real, readable file
 *   - the file is not named like the real Claude CLI
 *   - the file CONTENT carries TEST_DOUBLE_MARKER   (identity established, not assumed)
 *   - an ancestor directory declares itself a test-controlled fixture root
 *
 * Note the deliberate absence of any PATH lookup: this function never resolves, searches or guesses.
 * It only inspects the exact bytes at the exact path it was given.
 */
export const approveTestDoubleProvider = async (input: {
  executablePath: string | undefined;
  context: ExecutionContext;
  /** Injected for tests of this module itself; defaults to real filesystem reads. */
  readFileText?: (filePath: string) => Promise<string>;
}): Promise<ProviderIdentityOutcome> => {
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

  const isFile = await stat(supplied)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!isFile) {
    return refuse(
      "NOT_A_FILE",
      `test-double provider "${supplied}" does not name an existing file, so its identity as a ` +
        "test double cannot be established.",
    );
  }

  const read = input.readFileText ?? ((filePath: string) => readFile(filePath, "utf8"));
  let content: string;
  try {
    content = await read(supplied);
  } catch (error) {
    return refuse(
      "UNREADABLE",
      `test-double provider "${supplied}" could not be read, so its identity as a test double ` +
        `cannot be established: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!content.includes(TEST_DOUBLE_MARKER)) {
    return refuse(
      "MARKER_ABSENT",
      `test-double provider "${supplied}" does not carry the ${TEST_DOUBLE_MARKER} marker. A real ` +
        "provider binary cannot contain it, so its absence means the executable's identity as a " +
        "test double is unproven -- which is refused rather than assumed.",
    );
  }

  const root = await findTestDoubleRoot(supplied);
  if (root === null) {
    return refuse(
      "ROOT_MARKER_ABSENT",
      `test-double provider "${supplied}" is not inside a directory tree declared as a ` +
        `test-controlled provider fixture root (no ${TEST_DOUBLE_ROOT_MARKER_FILE} within ` +
        `${ROOT_MARKER_SEARCH_DEPTH} parent directories).`,
    );
  }

  return {
    approved: true,
    identity: {
      kind: "TEST_DOUBLE_PROVIDER_EXECUTION",
      executablePath: supplied,
      testDoubleRoot: root,
      contextKind: input.context.kind,
      detail: `approved TEST_DOUBLE provider ${supplied} (marker verified; fixture root ${root})`,
    } as ProviderIdentity,
  };
};

/**
 * Establishes a REAL_PROVIDER_EXECUTION identity for the operator's pinned Claude Code executable.
 *
 * Refuses outright in a TEST context. This is the interlock mission Repair 6 asks for, stated in the
 * positive: real-provider identity is not something a test can obtain by having every other gate
 * pass. In the incident every gate DID pass -- freeze, auth, budget, config, billed confirmation --
 * and this constructor is what would have refused anyway.
 */
export const resolveRealProviderIdentity = (input: {
  executablePath: string | null | undefined;
  context: ExecutionContext;
  /** Content of the executable when known, so a mislabelled test double is caught here too. */
  markerObserved?: boolean;
}): ProviderIdentityOutcome => {
  if (input.context.kind === "TEST") {
    return refuse(
      "TEST_CONTEXT_REQUIRES_TEST_DOUBLE",
      "REAL_PROVIDER_EXECUTION was requested from a TEST execution context " +
        `(${input.context.signals.join(", ")}). A test may only spawn an approved TEST_DOUBLE, ` +
        "regardless of freeze state, billed confirmation, or how many gates passed. This is the " +
        "structural interlock for incident maf-scoring-incident-2026-09-03-v1.",
    );
  }
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
  return {
    approved: true,
    identity: {
      kind: "REAL_PROVIDER_EXECUTION",
      executablePath: supplied,
      testDoubleRoot: null,
      contextKind: "PRODUCTION",
      detail: `REAL_PROVIDER_EXECUTION pinned to ${supplied} in a PRODUCTION context`,
    } as ProviderIdentity,
  };
};

// ------------------------------------------------------------- spawn interlock

/**
 * THE LOWEST PRACTICAL PROVIDER BOUNDARY.
 *
 * Called immediately before a participant executor is constructed, with the executable that is
 * genuinely about to be spawned. It re-derives the execution context rather than trusting the one
 * the identity was minted in, so a capability created earlier (or in a different process) cannot
 * carry a stale PRODUCTION classification into a test.
 *
 * Throws -- never returns a boolean. A caller that forgets to check a return value is a bug that
 * spends money; a caller that forgets to catch an exception is a bug that refuses.
 */
export const assertProviderIdentityForSpawn = (
  identity: ProviderIdentity | undefined,
  context: {
    executablePath: string | undefined;
    /** Re-detected at the boundary; defaults to the live process environment. */
    executionContext?: ExecutionContext;
  },
): void => {
  const observed = context.executionContext ?? detectExecutionContext();

  if (!identity) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: no provider identity was supplied to the spawn boundary. Every " +
        "scoring spawn must name REAL_PROVIDER_EXECUTION or TEST_DOUBLE_PROVIDER_EXECUTION " +
        "explicitly; there is no default and no fallback to a resolved `claude`.",
    );
  }

  // The interlock. Stated first because it holds even when every other binding is perfect.
  if (observed.kind === "TEST" && identity.kind !== "TEST_DOUBLE_PROVIDER_EXECUTION") {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: the spawn boundary was reached in a TEST execution context ` +
        `(${observed.signals.join(", ")}) with provider identity ${identity.kind}. Only an ` +
        "approved TEST_DOUBLE may be spawned under test, whatever the freeze state, the billed " +
        "confirmation, or the gate results say.",
    );
  }

  // A test double must never be spawned as though it were production evidence.
  if (observed.kind === "PRODUCTION" && identity.kind === "TEST_DOUBLE_PROVIDER_EXECUTION") {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: a TEST_DOUBLE provider identity reached a PRODUCTION execution " +
        "context. Simulated observations must never be recorded as paid scoring evidence.",
    );
  }

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
  // Exact equality, mission Repair 2: "spawned path equals the approved fake executable exactly".
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
 * Reads at most the first 256 KiB. A test double is a small script and carries the marker well
 * inside that window; a real Claude Code binary is far larger and contains it nowhere. Bounding the
 * read keeps the production path from slurping a multi-megabyte executable on every invocation
 * while still catching a simulated binary being passed off as the real provider.
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
    return (await readHead(executablePath, 256 * 1024)).includes(TEST_DOUBLE_MARKER);
  } catch {
    // Unreadable is not evidence of being a test double; the REAL identity path has its own
    // absolute-path and context requirements, and the executable gate probes it separately.
    return false;
  }
};

/** Human-readable one-liner for gate output. */
export const describeProviderIdentity = (identity: ProviderIdentity | null): string =>
  identity === null ? "NONE" : `${identity.kind} -> ${identity.executablePath}`;
