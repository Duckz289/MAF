// Effective Claude configuration gate.
//
// WHY THIS EXISTS, from proven history rather than caution. The first billed Protocol v2 preflight
// failed both arms with `is_error` results while the controller's own environment was clean and the
// adapter forwarded no ANTHROPIC_* variable to the child. Both process-level checks passed, and both
// were irrelevant: the routing lived in the user's `~/.claude/settings.json` `env` block, which the
// CLI reads for itself. The child inherits USERPROFILE (see the adapter's env allowlist), so it
// finds that file no matter how clean the spawn environment is.
//
// Three independent things must therefore be true before a paid scoring call, and they are reported
// separately because they fail for different reasons and have different fixes:
//
//   CONTROLLER_ENVIRONMENT_CLEAN        no ANTHROPIC_* routing in this process's own environment.
//   CHILD_ENVIRONMENT_FORWARDING_CLEAN  none of it would be forwarded to the participant.
//   CLAUDE_EFFECTIVE_CONFIG_CLEAN       no ACTIVE Claude settings file redirects the CLI itself.
//
// ACTIVE is the load-bearing word. This machine currently holds
// `~/.claude/settings.backup-maf-preflight-20260901.json`, which still contains the exact
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN routing that caused the invalid preflight. It is
// forensic evidence, the CLI never reads it, and a gate that flagged it would block every future
// scoring run over a file that changes nothing. Only files the CLI actually loads are inspected;
// backups, caches, logs, session history and per-project transcripts are explicitly excluded.
//
// No configuration VALUE is ever returned or logged -- only which key was set and in which file.
// Reporting that ANTHROPIC_AUTH_TOKEN is present is a finding; printing it is a credential leak.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Environment variables that can redirect the CLI away from first-party execution. */
export const ROUTING_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

/**
 * Routing destinations known to have been used to redirect this machine's CLI away from
 * first-party Anthropic. Matched as substrings against config VALUES, but only their names are ever
 * reported.
 */
export const KNOWN_ALTERNATE_ROUTES = [
  "api.stali.vn",
  "req/kimi-k3",
  "req/claude-sonnet-5",
] as const;

/** Hosts that ARE first-party Anthropic. A base URL pointing here redirects nothing. */
export const FIRST_PARTY_HOSTS = ["api.anthropic.com"] as const;

/**
 * Whether a routing value would actually send execution somewhere other than first-party.
 *
 * This distinction is what keeps the gate usable rather than merely loud.
 * `ANTHROPIC_BASE_URL=https://api.anthropic.com` is the official endpoint: it is a routing
 * variable, but it routes nowhere else. Treating its mere presence as a violation would make the
 * gate permanently unpassable on a correctly configured machine, and a gate that can never pass is
 * one somebody eventually weakens or bypasses -- a worse outcome than the risk it was guarding.
 *
 * So presence alone is advisory; REDIRECTION is what blocks.
 */
export const redirectsAwayFromFirstParty = (key: string, value: string): boolean => {
  if (KNOWN_ALTERNATE_ROUTES.some((route) => value.includes(route))) return true;
  if (key === "ANTHROPIC_BASE_URL") {
    try {
      return !(FIRST_PARTY_HOSTS as readonly string[]).includes(new URL(value).host);
    } catch {
      // A base URL that cannot even be parsed cannot be proven first-party. Fail closed.
      return true;
    }
  }
  // A credential or model override cannot change the participant unless it actually reaches the
  // child process; that is precisely what CHILD_ENVIRONMENT_FORWARDING_CLEAN exists to check.
  return false;
};

/**
 * Files the Claude Code CLI actually loads as configuration.
 *
 * Deliberately an allowlist of exact filenames rather than a glob. A glob over `~/.claude` would
 * sweep in backups, caches and transcripts -- material that records past routing without applying
 * any -- and turn preserved forensic evidence into a permanent false positive.
 */
export const ACTIVE_CONFIG_FILENAMES = ["settings.json", "settings.local.json"] as const;

export type ConfigCheckId =
  | "CONTROLLER_ENVIRONMENT_CLEAN"
  | "CHILD_ENVIRONMENT_FORWARDING_CLEAN"
  | "CLAUDE_EFFECTIVE_CONFIG_CLEAN";

export interface ConfigFinding {
  /** Which file or environment surface the finding came from. Never a value. */
  source: string;
  /** The configuration key that was set. Never its value. */
  key: string;
  /** Set when the value matched a known alternate route; names the route, not the credential. */
  matchedRoute?: string;
  detail: string;
}

export interface ConfigCheck {
  id: ConfigCheckId;
  passed: boolean;
  findings: ConfigFinding[];
  detail: string;
}

export interface EffectiveConfigReport {
  clean: boolean;
  checks: ConfigCheck[];
  /** Active config files that were actually found and read. */
  inspectedFiles: string[];
  /** Files deliberately NOT treated as configuration, with the reason. */
  excludedPaths: string[];
  summary: string;
}

/** The Claude configuration directory, built with path.join so it can never become `...Admin.claude`. */
export const claudeConfigDir = (home: string = homedir()): string => path.join(home, ".claude");

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

/** Recursively collects routing keys and alternate-route hits from a parsed settings object. */
const scanSettingsObject = (value: unknown, source: string, breadcrumb = ""): ConfigFinding[] => {
  const findings: ConfigFinding[] = [];
  if (value === null || typeof value !== "object") return findings;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findings.push(...scanSettingsObject(entry, source, `${breadcrumb}[${index}]`));
    });
    return findings;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const where = breadcrumb ? `${breadcrumb}.${key}` : key;
    if ((ROUTING_ENV_KEYS as readonly string[]).includes(key)) {
      const matchedRoute =
        typeof entry === "string"
          ? KNOWN_ALTERNATE_ROUTES.find((route) => entry.includes(route))
          : undefined;
      findings.push({
        source,
        key,
        ...(matchedRoute ? { matchedRoute } : {}),
        detail:
          `${where} is set in active configuration` +
          (matchedRoute ? `, routing to ${matchedRoute}` : "") +
          "; this overrides first-party execution for the participant CLI",
      });
      continue;
    }
    if (typeof entry === "string") {
      const matchedRoute = KNOWN_ALTERNATE_ROUTES.find((route) => entry.includes(route));
      if (matchedRoute) {
        findings.push({
          source,
          key: where,
          matchedRoute,
          detail: `${where} references the alternate route ${matchedRoute} in active configuration`,
        });
      }
      continue;
    }
    findings.push(...scanSettingsObject(entry, source, where));
  }
  return findings;
};

export interface EffectiveConfigOptions {
  /** Overridable for tests; defaults to the real user profile. */
  home?: string;
  /** Overridable for tests; defaults to this process's environment. */
  environment?: NodeJS.ProcessEnv;
  /**
   * Environment keys the adapter actually forwards to the participant. Supplied by the caller so
   * this module states a fact about the real adapter rather than restating its allowlist here.
   */
  forwardedEnvironmentKeys?: readonly string[];
  /**
   * Directories the participant will actually run in.
   *
   * Claude Code loads `<cwd>/.claude/settings.json` in addition to the user-level file, so a
   * workspace-local settings file can redirect the participant even when the user profile is
   * spotless. The participant's cwd is a controller-created workspace, but the fixture it is
   * populated from lives in the repository -- so a `.claude` directory committed into a task fixture
   * would be copied straight into the workspace and silently take effect. Scanning the actual
   * participant directories closes that.
   */
  workspacePaths?: readonly string[];
}

export const inspectEffectiveClaudeConfig = async (
  options: EffectiveConfigOptions = {},
): Promise<EffectiveConfigReport> => {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const configDir = claudeConfigDir(home);

  // 1. The controller's own environment. Presence is recorded; only actual redirection blocks.
  const controllerPresent = ROUTING_ENV_KEYS.filter(
    (key) => typeof environment[key] === "string" && (environment[key] as string).length > 0,
  );
  const controllerRedirecting = controllerPresent.filter((key) =>
    redirectsAwayFromFirstParty(key, environment[key] as string),
  );
  const controllerFindings: ConfigFinding[] = controllerPresent.map((key) => {
    const value = environment[key] as string;
    const matchedRoute = KNOWN_ALTERNATE_ROUTES.find((route) => value.includes(route));
    return {
      source: "process.env",
      key,
      ...(matchedRoute ? { matchedRoute } : {}),
      detail: redirectsAwayFromFirstParty(key, value)
        ? `${key} is set in the controller's own environment and points AWAY from first-party` +
          (matchedRoute ? ` (${matchedRoute})` : "")
        : `${key} is set in the controller's own environment but does not redirect away from ` +
          "first-party; it is also not forwarded to the participant, so it is advisory only",
    };
  });

  // 2. What would actually reach the child.
  const forwarded = options.forwardedEnvironmentKeys ?? [];
  const forwardedFindings: ConfigFinding[] = ROUTING_ENV_KEYS.filter((key) =>
    forwarded.includes(key),
  ).map((key) => ({
    source: "adapter spawn env allowlist",
    key,
    detail: `${key} would be forwarded to the participant process`,
  }));

  // 3. The CLI's own active configuration: user-level AND every participant workspace.
  const inspectedFiles: string[] = [];
  const configFindings: ConfigFinding[] = [];
  const configDirs = [
    configDir,
    ...(options.workspacePaths ?? []).map((w) => path.join(w, ".claude")),
  ];

  for (const dir of configDirs) {
    for (const filename of ACTIVE_CONFIG_FILENAMES) {
      const filePath = path.join(dir, filename);
      if (!(await fileExists(filePath))) continue;
      inspectedFiles.push(filePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        // An unreadable active config is not evidence of cleanliness; fail closed.
        configFindings.push({
          source: filePath,
          key: "(unparseable)",
          detail: `active configuration could not be parsed, so it cannot be proven clean: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
      configFindings.push(...scanSettingsObject(parsed, filePath));
    }
  }

  const excludedPaths = [
    `${path.join(configDir, "backups")} (historical backups are never loaded by the CLI)`,
    `${path.join(configDir, "cache")} (cache is not configuration)`,
    `${path.join(configDir, "projects")} (per-project transcripts are not configuration)`,
    `${path.join(configDir, "sessions")} (session history is not configuration)`,
    `${path.join(configDir, "history.jsonl")} (command history is not configuration)`,
    `${path.join(configDir, "settings.backup-*.json")} (timestamped backups are not loaded)`,
  ];

  const checks: ConfigCheck[] = [
    {
      id: "CONTROLLER_ENVIRONMENT_CLEAN",
      // Blocks only on genuine redirection. A first-party base URL that is never forwarded to the
      // child cannot change which provider the participant reaches.
      passed: controllerRedirecting.length === 0,
      findings: controllerFindings,
      detail:
        controllerRedirecting.length > 0
          ? `${controllerRedirecting.length} controller environment variable(s) redirect away from ` +
            `first-party: ${controllerRedirecting.join(", ")}`
          : controllerFindings.length === 0
            ? "no ANTHROPIC_* routing is present in the controller's environment"
            : `${controllerFindings.length} routing variable(s) present in the controller ` +
              `environment (${controllerFindings.map((f) => f.key).join(", ")}), none redirecting ` +
              "away from first-party and none forwarded to the participant",
    },
    {
      id: "CHILD_ENVIRONMENT_FORWARDING_CLEAN",
      passed: forwardedFindings.length === 0,
      findings: forwardedFindings,
      detail:
        forwardedFindings.length === 0
          ? "the adapter forwards no ANTHROPIC_* variable to the participant"
          : `the adapter would forward: ${forwardedFindings.map((f) => f.key).join(", ")}`,
    },
    {
      id: "CLAUDE_EFFECTIVE_CONFIG_CLEAN",
      passed: configFindings.length === 0,
      findings: configFindings,
      detail:
        configFindings.length === 0
          ? `no active Claude configuration overrides first-party routing (inspected ${
              inspectedFiles.length
            } file(s); backups, caches, logs and transcripts excluded)`
          : `active Claude configuration would override first-party execution: ${configFindings
              .map((f) => `${f.key} in ${path.basename(f.source)}`)
              .join(", ")}`,
    },
  ];

  const failed = checks.filter((check) => !check.passed);
  return {
    clean: failed.length === 0,
    checks,
    inspectedFiles,
    excludedPaths,
    summary:
      failed.length === 0
        ? "controller environment, child forwarding and effective Claude configuration are all clean"
        : `${failed.length} configuration surface(s) would redirect the participant away from ` +
          `first-party execution: ${failed.map((c) => c.id).join(", ")}`,
  };
};
