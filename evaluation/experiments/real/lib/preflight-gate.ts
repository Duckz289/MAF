// Non-billed preflight gate: everything that must be proven BEFORE a billed provider call.
//
// The first billed Protocol v2 preflight reported "claude CLI AVAILABLE, version 2.1.251" and then
// spawned the bare string "claude" resolved through whatever PATH the invoking process happened to
// have -- so the binary that was version-checked was never provably the binary that ran, and no auth
// state was verified at all. Every check here resolves ONE executable path and reuses it for the
// version check, the auth check and the real execution.
//
// None of these checks makes a model call.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeExecutableResolution {
  resolved: boolean;
  /** Absolute path or bare command actually verified, reused verbatim for execution. */
  path: string | null;
  version: string | null;
  detail: string;
}

export interface ClaudeAuthGate {
  checked: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  detail: string;
}

export interface EnvironmentRoutingGate {
  /** True when an ANTHROPIC_MODEL override exists in the CONTROLLER's own environment. */
  externalModelOverridePresent: boolean;
  externalBaseUrlOverridePresent: boolean;
  externalAuthTokenPresent: boolean;
  /** Whether any of them would reach the participant process. Must be false. */
  externalModelOverrideForwarded: boolean;
  externalBaseUrlOverrideForwarded: boolean;
  externalAuthTokenForwarded: boolean;
  detail: string;
}

/**
 * Resolves the Claude Code executable and captures its version, without a model call.
 *
 * `preferredPath` (when given) is used verbatim so the caller can pin an exact binary. Otherwise the
 * bare `claude` command is probed, and whatever the OS resolves is what execution will also use.
 */
export const resolveClaudeExecutable = async (
  preferredPath?: string,
): Promise<ClaudeExecutableResolution> => {
  const candidate = preferredPath ?? "claude";
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 15_000 });
    return {
      resolved: true,
      path: candidate,
      version: stdout.trim(),
      detail: `resolved and version-checked: ${candidate}`,
    };
  } catch (error) {
    return {
      resolved: false,
      path: null,
      version: null,
      detail: `could not run ${candidate} --version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

/**
 * Verifies the SAME executable is authenticated, using `claude auth status` -- which reports
 * credential state and makes no model call. Never logs or returns any credential material: only the
 * boolean state and the non-secret method/provider labels the command itself prints.
 */
export const checkClaudeAuth = async (executablePath: string): Promise<ClaudeAuthGate> => {
  try {
    const { stdout } = await execFileAsync(executablePath, ["auth", "status"], { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiProvider?: unknown;
    };
    const loggedIn = parsed.loggedIn === true;
    return {
      checked: true,
      loggedIn,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
      detail: loggedIn
        ? "the resolved executable is authenticated"
        : "the resolved executable is NOT authenticated",
    };
  } catch (error) {
    // `claude auth status` exits non-zero when logged out, which lands here; that is a definite
    // "not authenticated", not an inconclusive check.
    const message = error instanceof Error ? error.message : String(error);
    const stdout = (error as { stdout?: string }).stdout ?? "";
    let loggedIn = false;
    let authMethod: string | null = null;
    let apiProvider: string | null = null;
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      loggedIn = parsed.loggedIn === true;
      authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : null;
      apiProvider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : null;
      return {
        checked: true,
        loggedIn,
        authMethod,
        apiProvider,
        detail: "the resolved executable reported it is NOT authenticated",
      };
    } catch {
      return {
        checked: false,
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        detail: `could not determine auth state: ${message}`,
      };
    }
  }
};

/**
 * Proves the participant process is not being redirected through an unintended provider.
 *
 * The controller's own environment legitimately carries ANTHROPIC_* routing for whatever harness is
 * running it. `ClaudeCodeAdapter` forwards a curated allowlist that deliberately excludes all of it,
 * so the participant always uses the CLI's own native auth and endpoint. This gate records that
 * separation as an explicit, checkable fact rather than an assumed one -- and never records any
 * value, only presence.
 */
export const checkEnvironmentRouting = (
  environment: NodeJS.ProcessEnv = process.env,
): EnvironmentRoutingGate => {
  const modelPresent =
    typeof environment.ANTHROPIC_MODEL === "string" && environment.ANTHROPIC_MODEL.length > 0;
  const baseUrlPresent =
    typeof environment.ANTHROPIC_BASE_URL === "string" && environment.ANTHROPIC_BASE_URL.length > 0;
  const tokenPresent =
    typeof environment.ANTHROPIC_AUTH_TOKEN === "string" &&
    environment.ANTHROPIC_AUTH_TOKEN.length > 0;
  return {
    externalModelOverridePresent: modelPresent,
    externalBaseUrlOverridePresent: baseUrlPresent,
    externalAuthTokenPresent: tokenPresent,
    // ClaudeCodeAdapter's spawn env allowlist contains no ANTHROPIC_* variable, so none of these can
    // reach the child. Asserted by tests/claude-code-adapter-env.test.ts rather than assumed here.
    externalModelOverrideForwarded: false,
    externalBaseUrlOverrideForwarded: false,
    externalAuthTokenForwarded: false,
    detail:
      modelPresent || baseUrlPresent || tokenPresent
        ? "the controller's own environment carries ANTHROPIC_* routing; none of it is forwarded to " +
          "the participant, which uses the Claude Code CLI's own native authentication and endpoint"
        : "no ANTHROPIC_* routing is present in the controller environment",
  };
};
