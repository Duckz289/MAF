// Pins ONE Claude Code executable for version, authentication and execution.
//
// The first billed Protocol v2 preflight reported "claude CLI AVAILABLE, version 2.1.251" and then
// spawned the bare string `claude`, resolved through whatever PATH the spawning process happened to
// have. The binary that was version-checked was never provably the binary that ran, and no auth
// state was checked at all. This module closes that by resolving the executable exactly once and
// handing the SAME path to all three uses.
//
// Neither probe invokes a model. `claude --version` prints a version string; `claude auth status`
// reports credential state. Both are cheap, local, and free -- which is what makes it possible to
// prove first-party authentication before spending anything.
//
// The resolution and auth primitives are the audited Protocol v2 ones
// (evaluation/experiments/real/lib/preflight-gate.ts), reused rather than reimplemented; this module
// only composes them and enforces the "same path everywhere" invariant.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  checkClaudeAuth,
  resolveClaudeExecutable,
  type ClaudeAuthGate,
  type ClaudeExecutableResolution,
} from "../../real/lib/preflight-gate";

const execFileAsync = promisify(execFile);

/**
 * Resolves a bare command to an ABSOLUTE path before anything probes or spawns it.
 *
 * The audited Protocol v2 primitive accepts the bare string `claude` and notes that "whatever the
 * OS resolves is what execution will also use". That is true within one process, but it still means
 * each spawn performs its own PATH lookup: a PATH change, a shim swap, or a differently-configured
 * child environment between the probe and a 30-minute run would silently substitute a different
 * binary. Resolving once to an absolute path removes the lookup entirely, so the binary that was
 * version- and auth-checked is the same inode that executes.
 *
 * Returns null when the command cannot be located, which the caller treats as not pinned.
 */
export const resolveAbsoluteCommandPath = async (
  command: string,
  locate?: (cmd: string) => Promise<string[]>,
): Promise<string | null> => {
  if (path.isAbsolute(command)) return command;
  const lookup =
    locate ??
    (async (cmd: string): Promise<string[]> => {
      const finder = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(finder, [cmd], { timeout: 15_000 });
      return stdout.split(/\r?\n/u).map((line) => line.trim());
    });
  try {
    const candidates = (await lookup(command)).filter((line) => line.length > 0);
    const absolute = candidates.find((candidate) => path.isAbsolute(candidate));
    return absolute ?? null;
  } catch {
    return null;
  }
};

/** Auth methods that indicate a first-party claude.ai / OAuth session rather than an API key. */
export const FIRST_PARTY_AUTH_METHODS = ["claude.ai", "oauth_token", "oauth"] as const;
export const FIRST_PARTY_API_PROVIDER = "firstParty";

export interface PinnedExecutable {
  /** True only when one path was resolved AND both probes ran against that same path. */
  pinned: boolean;
  /** The single path used for --version, auth status, and future participant execution. */
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  /** True when the session is first-party by BOTH provider and auth method. */
  firstParty: boolean;
  /** Every path any probe was invoked with. Must have exactly one distinct entry. */
  probedPaths: string[];
  /** True when the pinned path is absolute, so no PATH lookup happens at spawn time. */
  pathIsAbsolute: boolean;
  detail: string;
}

export interface PinExecutableOptions {
  /** Pins an exact binary. Otherwise the bare `claude` command is resolved once and reused. */
  preferredPath?: string;
  /** Injection points for tests. Defaults are the audited Protocol v2 primitives. */
  resolve?: (preferredPath?: string) => Promise<ClaudeExecutableResolution>;
  checkAuth?: (executablePath: string) => Promise<ClaudeAuthGate>;
  /** Injection point for absolute-path lookup (`where` / `which`). */
  locate?: (command: string) => Promise<string[]>;
}

const isFirstParty = (auth: ClaudeAuthGate): boolean =>
  auth.apiProvider === FIRST_PARTY_API_PROVIDER &&
  typeof auth.authMethod === "string" &&
  (FIRST_PARTY_AUTH_METHODS as readonly string[]).includes(auth.authMethod);

/**
 * Resolves once, then probes version and auth against that exact path.
 *
 * `probedPaths` records every path actually handed to a probe so a test (and an auditor) can prove
 * there was only ever one. That is the property the audit asked for: no PATH resolution for the
 * probe and a different one for execution.
 */
export const pinClaudeExecutable = async (
  options: PinExecutableOptions = {},
): Promise<PinnedExecutable> => {
  const resolve = options.resolve ?? resolveClaudeExecutable;
  const checkAuth = options.checkAuth ?? checkClaudeAuth;
  const probedPaths: string[] = [];

  // Pin an absolute path FIRST, so every subsequent probe and spawn names the same binary rather
  // than re-running a PATH lookup that could resolve differently later.
  const requested = options.preferredPath ?? "claude";
  const absolute = await resolveAbsoluteCommandPath(requested, options.locate);
  const resolution = await resolve(absolute ?? requested);
  if (!resolution.resolved || !resolution.path) {
    return {
      pinned: false,
      path: null,
      version: null,
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      firstParty: false,
      probedPaths,
      pathIsAbsolute: false,
      detail: `no Claude Code executable could be resolved: ${resolution.detail}`,
    };
  }
  // The resolution itself ran `--version` against this path; record it as the first probe.
  probedPaths.push(resolution.path);

  const auth = await checkAuth(resolution.path);
  probedPaths.push(resolution.path);

  const firstParty = isFirstParty(auth);
  const distinct = [...new Set(probedPaths)];
  const pathIsAbsolute = path.isAbsolute(resolution.path);
  // "Pinned" requires BOTH that every probe used one path AND that the path is absolute; a bare
  // command shared by all three uses is still a PATH lookup repeated three times.
  const singlePath = distinct.length === 1 && pathIsAbsolute;

  return {
    pinned: singlePath,
    path: resolution.path,
    version: resolution.version,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    apiProvider: auth.apiProvider,
    firstParty,
    probedPaths,
    pathIsAbsolute,
    detail:
      distinct.length !== 1
        ? `probes did not share one executable path: ${distinct.join(", ")}`
        : !pathIsAbsolute
          ? `${resolution.path} is not an absolute path, so each spawn would repeat a PATH lookup ` +
            "that could resolve to a different binary; pass --claude-path to pin one"
          : !auth.loggedIn
            ? `${resolution.path} is resolved (${resolution.version ?? "unknown version"}) but NOT authenticated`
            : !firstParty
              ? `${resolution.path} is authenticated, but apiProvider=${String(auth.apiProvider)} / ` +
                `authMethod=${String(auth.authMethod)} is not a first-party claude.ai session; a ` +
                "scoring run routed through another provider is not the frozen experiment"
              : `${resolution.path} (${resolution.version ?? "unknown version"}) pinned for version, ` +
                `auth and execution; first-party session via ${String(auth.authMethod)}`,
  };
};

/** Whether this pinned executable may be used for a billed scoring run. */
export const executableAuthorizedForScoring = (pinned: PinnedExecutable): boolean =>
  pinned.pinned && pinned.loggedIn && pinned.firstParty && pinned.path !== null;
