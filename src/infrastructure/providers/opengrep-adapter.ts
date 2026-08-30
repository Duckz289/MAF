import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AnalysisCoverage } from "../../domain/assurance";
import type { CapabilityId } from "../../domain/assurance-obligation";
import type {
  CapabilityFinding,
  CapabilityInput,
  CapabilityProbe,
  CapabilityProbeOptions,
  CapabilityProvider,
  CapabilityResult,
  ProviderExecution,
} from "../../domain/capability/provider";
import type { EstablishmentTarget, LanguageClass } from "../../domain/capability-adequacy";
import { languageClassOf } from "../../domain/capability-adequacy";

export const OPEN_GREP_PINNED_VERSION = "1.27.1";

const capabilityId = "SECURITY.SEMANTIC_FLOW_SCAN" satisfies CapabilityId;
const providerName = "opengrep";
const defaultProbeTimeoutMs = 5_000;
const rulesetDigestDomain = "MAF_OPENGREP_RULESET_V1";

const languageClasses = [
  "TS_JS",
  "PYTHON",
  "SHELL",
  "GENERIC_SCRIPTING",
  "BOUNDED_COMPILED",
  "UNMODELLED",
  "CONFIG_WORKFLOW",
] as const satisfies readonly LanguageClass[];

const languageClassSet = new Set<string>(languageClasses);

/**
 * OpenGrep may only speak for targets that SECURITY.SEMANTIC_FLOW_SCAN already establishes.
 * Adding a rule for a new concern requires a separate domain adequacy decision first.
 */
export type OpenGrepEstablishmentTarget = Extract<
  EstablishmentTarget,
  "SECURITY.SENSITIVE_INPUT_FLOW" | "SECURITY.ENV_SECRET_EXPOSURE"
>;

const allowedTargets = new Set<string>([
  "SECURITY.SENSITIVE_INPUT_FLOW",
  "SECURITY.ENV_SECRET_EXPOSURE",
]);

export interface OpenGrepRuleManifestEntry {
  /** Exact ID from the MAF-owned rule. `--no-rewrite-rule-ids` keeps it stable. */
  ruleId: string;
  /** Exact typed concern raised by a match; never a broad Security bucket. */
  target: OpenGrepEstablishmentTarget;
  /** MAF language classes for which the audited rule is applicable. */
  languageClasses: readonly LanguageClass[];
  /** Expected normalized severity; output that disagrees with the manifest is rejected. */
  severity: CapabilityFinding["severity"];
  /** Trusted, non-secret message. Candidate-expanded output messages are not retained. */
  message: string;
}

export interface OpenGrepRuleManifest {
  rules: readonly OpenGrepRuleManifestEntry[];
}

/** A process request whose implementation owns stdout/stderr size bounds and tree termination. */
export interface BoundedProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Structural process facts; adapters never infer timeout or cancellation from output text. */
export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

export interface BoundedProcessRunner {
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

export interface OpenGrepTargetBounds {
  /** Maximum number of entries accepted from changedFiles, before de-duplication. */
  maxCount: number;
  /** Maximum total UTF-8 bytes for the complete scan argument vector, including separators. */
  maxArgumentBytes: number;
  /** Maximum size of each explicit changed-file target. */
  maxFileBytes: number;
}

const defaultTargetBounds: OpenGrepTargetBounds = {
  maxCount: 32,
  maxArgumentBytes: 16_384,
  maxFileBytes: 1_048_576,
};

export interface OpenGrepRulesetBounds {
  /** Maximum bytes read from the single local rule file. */
  maxFileBytes: number;
  /** Maximum number of exact rules in the trusted manifest. */
  maxRuleCount: number;
  /** Maximum UTF-8 bytes in each trusted rule ID. */
  maxRuleIdBytes: number;
  /** Maximum UTF-8 bytes in each trusted finding message. */
  maxMessageBytes: number;
}

const maximumRulesetBounds: OpenGrepRulesetBounds = {
  maxFileBytes: 1_048_576,
  maxRuleCount: 128,
  maxRuleIdBytes: 256,
  maxMessageBytes: 2_048,
};

export interface OpenGrepAdapterConfig {
  /** Absolute path to the separately installed, operator-verified executable. */
  command: string;
  /** Absolute local path to one external MAF-owned regular, non-symlink rule file. */
  rulesPath: string;
  /** Digest from computeOpenGrepRulesetDigest for the audited rule bytes and manifest. */
  rulesetDigest: string;
  manifest: OpenGrepRuleManifest;
  /** Defaults are conservative hard maxima; callers may only narrow them. */
  rulesetBounds?: OpenGrepRulesetBounds;
  /** Conservative defaults apply when the outer composition does not narrow these bounds. */
  targetBounds?: OpenGrepTargetBounds;
  timeoutMs: number;
  probeTimeoutMs?: number;
  runner: BoundedProcessRunner;
  now?: () => Date;
}

interface TrustedRule {
  target: OpenGrepEstablishmentTarget;
  languageClasses: ReadonlySet<LanguageClass>;
  severity: CapabilityFinding["severity"];
  message: string;
}

interface NormalizedManifest {
  canonical: string;
  rules: Map<string, TrustedRule>;
  applicableClasses: Set<LanguageClass>;
}

type RulesVerification = { ok: true; digest: string } | { ok: false; detail: string };

interface ValidatedTarget {
  candidatePath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

type TargetValidation =
  | { ok: true; targets: ReadonlyMap<string, ValidatedTarget> }
  | { ok: false; detail: string };

interface ParsedOutput {
  findings: CapabilityFinding[];
  analyzedFiles: string[];
  coverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
}

type OutputDecision =
  | { ok: true; output: ParsedOutput }
  | { ok: false; execution: ProviderExecution };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isWithin = (root: string, candidate: string): boolean => {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
};

const toPortablePath = (value: string): string => value.split(sep).join("/");

const pathKey = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const looksRemote = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^git\+/iu.test(value);

const looksLikeUncPath = (value: string): boolean =>
  value.startsWith("\\\\") || value.startsWith("//");

const assertAbsoluteLocalPath = (label: string, value: string): void => {
  if (
    !isNonEmptyText(value) ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    looksRemote(value) ||
    looksLikeUncPath(value)
  ) {
    throw new Error(`${label} must be an absolute local filesystem path`);
  }
};

const assertPositiveTimeout = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
};

const assertRulesetBounds = (bounds: OpenGrepRulesetBounds): void => {
  for (const [name, value, maximum] of [
    ["maxFileBytes", bounds.maxFileBytes, maximumRulesetBounds.maxFileBytes],
    ["maxRuleCount", bounds.maxRuleCount, maximumRulesetBounds.maxRuleCount],
    ["maxRuleIdBytes", bounds.maxRuleIdBytes, maximumRulesetBounds.maxRuleIdBytes],
    ["maxMessageBytes", bounds.maxMessageBytes, maximumRulesetBounds.maxMessageBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`OpenGrep rulesetBounds.${name} must be between 1 and ${maximum}`);
    }
  }
};

const unsupportedNegativeCoverage = (): Record<LanguageClass, AnalysisCoverage> => ({
  TS_JS: "UNSUPPORTED",
  PYTHON: "UNSUPPORTED",
  SHELL: "UNSUPPORTED",
  GENERIC_SCRIPTING: "UNSUPPORTED",
  BOUNDED_COMPILED: "UNSUPPORTED",
  UNMODELLED: "UNSUPPORTED",
  CONFIG_WORKFLOW: "UNSUPPORTED",
});

const malformed = (detail: string): OutputDecision => ({
  ok: false,
  execution: { outcome: "MALFORMED_OUTPUT", detail },
});

const normalizeSeverity = (value: unknown): CapabilityFinding["severity"] | null => {
  switch (value) {
    case "CRITICAL":
      return "CRITICAL";
    case "ERROR":
    case "HIGH":
      return "HIGH";
    case "WARNING":
    case "MEDIUM":
      return "MEDIUM";
    case "LOW":
      return "LOW";
    case "INFO":
      return "INFO";
    default:
      return null;
  }
};

const normalizeManifest = (
  manifest: OpenGrepRuleManifest,
  bounds: OpenGrepRulesetBounds,
): NormalizedManifest => {
  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) {
    throw new Error("OpenGrep manifest must contain at least one audited rule");
  }
  if (manifest.rules.length > bounds.maxRuleCount) {
    throw new Error("OpenGrep manifest exceeded the configured rule-count bound");
  }

  const rules = new Map<string, TrustedRule>();
  const applicableClasses = new Set<LanguageClass>();
  for (const entry of manifest.rules) {
    if (!isNonEmptyText(entry.ruleId) || entry.ruleId !== entry.ruleId.trim()) {
      throw new Error("OpenGrep manifest rule IDs must be non-empty exact text");
    }
    if (Buffer.byteLength(entry.ruleId, "utf8") > bounds.maxRuleIdBytes) {
      throw new Error("OpenGrep manifest rule ID exceeded the configured byte bound");
    }
    if (rules.has(entry.ruleId)) {
      throw new Error("OpenGrep manifest rule IDs must be unique");
    }
    if (!allowedTargets.has(entry.target)) {
      throw new Error("OpenGrep rules may map only to established semantic-flow targets");
    }
    if (!isNonEmptyText(entry.message)) {
      throw new Error("OpenGrep manifest messages must be non-empty trusted text");
    }
    if (Buffer.byteLength(entry.message, "utf8") > bounds.maxMessageBytes) {
      throw new Error("OpenGrep manifest message exceeded the configured byte bound");
    }
    if (!Array.isArray(entry.languageClasses) || entry.languageClasses.length === 0) {
      throw new Error("OpenGrep manifest rules must declare applicable language classes");
    }
    const classes = new Set<LanguageClass>();
    for (const languageClass of entry.languageClasses) {
      if (!languageClassSet.has(languageClass)) {
        throw new Error("OpenGrep manifest contains an unknown language class");
      }
      classes.add(languageClass);
      applicableClasses.add(languageClass);
    }
    if (normalizeSeverity(entry.severity) !== entry.severity) {
      throw new Error("OpenGrep manifest contains an invalid normalized severity");
    }
    rules.set(entry.ruleId, {
      target: entry.target,
      languageClasses: classes,
      severity: entry.severity,
      message: entry.message.trim(),
    });
  }

  const canonical = JSON.stringify({
    rules: [...rules.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([ruleId, rule]) => ({
        languageClasses: [...rule.languageClasses].sort(compareCodeUnits),
        message: rule.message,
        ruleId,
        severity: rule.severity,
        target: rule.target,
      })),
  });

  return { canonical, rules, applicableClasses };
};

const digestRuleset = (ruleBytes: Uint8Array, canonicalManifest: string): string => {
  const manifestBytes = Buffer.from(canonicalManifest, "utf8");
  const framing = Buffer.allocUnsafe(16);
  framing.writeBigUInt64BE(BigInt(manifestBytes.byteLength), 0);
  framing.writeBigUInt64BE(BigInt(ruleBytes.byteLength), 8);
  const digest = createHash("sha256")
    .update(rulesetDigestDomain, "utf8")
    .update("\0", "utf8")
    .update(framing)
    .update(manifestBytes)
    .update(ruleBytes)
    .digest("hex");
  return `sha256:${digest}`;
};

/**
 * Computes the adapter's versioned digest over exact rule bytes and a normalized manifest.
 * Rule order and language-class order are canonicalized; duplicate rule IDs remain invalid.
 */
export const computeOpenGrepRulesetDigest = (
  ruleBytes: Uint8Array,
  manifest: OpenGrepRuleManifest,
  bounds: OpenGrepRulesetBounds = maximumRulesetBounds,
): string => {
  assertRulesetBounds(bounds);
  if (ruleBytes.byteLength > bounds.maxFileBytes) {
    throw new Error("OpenGrep rule bytes exceeded the configured file-size bound");
  }
  return digestRuleset(ruleBytes, normalizeManifest(manifest, bounds).canonical);
};

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const normalizeCandidateFile = (sandboxPath: string, file: string): string | null => {
  if (
    !isNonEmptyText(file) ||
    file.includes("\0") ||
    isAbsolute(file) ||
    /^[a-z]:[\\/]/iu.test(file) ||
    looksLikeUncPath(file)
  ) {
    return null;
  }
  const absolute = resolve(sandboxPath, file);
  if (!isWithin(sandboxPath, absolute) || absolute === sandboxPath) return null;
  const normalized = toPortablePath(relative(sandboxPath, absolute));
  return normalized.length > 0 ? normalized : null;
};

const normalizeReportedFile = (sandboxPath: string, file: string): string | null => {
  if (!isNonEmptyText(file) || file.includes("\0") || looksRemote(file)) return null;
  const absolute = isAbsolute(file) ? resolve(file) : resolve(sandboxPath, file);
  if (!isWithin(sandboxPath, absolute) || absolute === sandboxPath) return null;
  const normalized = toPortablePath(relative(sandboxPath, absolute));
  return normalized.length > 0 ? normalized : null;
};

const diagnosticDetail = (prefix: string, result: BoundedProcessResult): string => {
  if (result.spawnError !== undefined) return `${prefix}: process could not be started`;
  return `${prefix}: process exited with code ${result.exitCode ?? "unknown"}`;
};

export class OpenGrepAdapter implements CapabilityProvider {
  readonly capabilityId = capabilityId;
  readonly name = providerName;

  private readonly command: string;
  private readonly rulesPath: string;
  private readonly rulesetDigest: string;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly runner: BoundedProcessRunner;
  private readonly now: () => Date;
  private readonly targetBounds: OpenGrepTargetBounds;
  private readonly rulesetBounds: OpenGrepRulesetBounds;
  private readonly rules: ReadonlyMap<string, TrustedRule>;
  private readonly applicableClasses: ReadonlySet<LanguageClass>;
  private readonly canonicalManifest: string;
  private probePromise: Promise<CapabilityProbe> | undefined;

  constructor(config: OpenGrepAdapterConfig) {
    assertAbsoluteLocalPath("OpenGrep command", config.command);
    assertAbsoluteLocalPath("OpenGrep rulesPath", config.rulesPath);
    if (!/^sha256:[a-f0-9]{64}$/iu.test(config.rulesetDigest)) {
      throw new Error("OpenGrep rulesetDigest must be a sha256 digest");
    }
    assertPositiveTimeout("OpenGrep timeoutMs", config.timeoutMs);
    const probeTimeoutMs = config.probeTimeoutMs ?? defaultProbeTimeoutMs;
    assertPositiveTimeout("OpenGrep probeTimeoutMs", probeTimeoutMs);
    const targetBounds = config.targetBounds ?? defaultTargetBounds;
    assertPositiveTimeout("OpenGrep targetBounds.maxCount", targetBounds.maxCount);
    assertPositiveTimeout("OpenGrep targetBounds.maxArgumentBytes", targetBounds.maxArgumentBytes);
    assertPositiveTimeout("OpenGrep targetBounds.maxFileBytes", targetBounds.maxFileBytes);
    const rulesetBounds = config.rulesetBounds ?? maximumRulesetBounds;
    assertRulesetBounds(rulesetBounds);
    const normalizedManifest = normalizeManifest(config.manifest, rulesetBounds);

    this.command = resolve(config.command);
    this.rulesPath = resolve(config.rulesPath);
    this.rulesetDigest = config.rulesetDigest.toLowerCase();
    this.timeoutMs = config.timeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.runner = config.runner;
    this.now = config.now ?? (() => new Date());
    this.targetBounds = { ...targetBounds };
    this.rulesetBounds = { ...rulesetBounds };
    this.rules = normalizedManifest.rules;
    this.applicableClasses = normalizedManifest.applicableClasses;
    this.canonicalManifest = normalizedManifest.canonical;
  }

  probe(options: CapabilityProbeOptions = {}): Promise<CapabilityProbe> {
    if (options.fresh === true) this.probePromise = this.performProbe();
    this.probePromise ??= this.performProbe();
    return this.probePromise;
  }

  async analyze(input: CapabilityInput): Promise<CapabilityResult> {
    const invokedAt = this.now().toISOString();
    const startedAt = Date.now();
    const earlyResult = (
      execution: ProviderExecution,
      durationMs = Math.max(0, Date.now() - startedAt),
    ): CapabilityResult => this.result(input, invokedAt, durationMs, execution);

    if (input.capabilityId !== this.capabilityId) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "The requested capability does not match this provider.",
      });
    }
    if (input.signal?.aborted === true) {
      return earlyResult({ outcome: "REFUSED", detail: "Execution was cancelled before launch." });
    }
    if (!isAbsolute(input.sandbox.path)) {
      return earlyResult({ outcome: "REFUSED", detail: "Sandbox path is not absolute." });
    }

    const sandboxPath = resolve(input.sandbox.path);
    if (isWithin(sandboxPath, this.command) || isWithin(sandboxPath, this.rulesPath)) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "Executable and rules must be outside the candidate sandbox.",
      });
    }
    if (input.diff.changedFiles.length > this.targetBounds.maxCount) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "The changed-file list exceeded the configured target-count bound.",
      });
    }

    const targetByKey = new Map<string, string>();
    for (const changedFile of input.diff.changedFiles) {
      const normalized = normalizeCandidateFile(sandboxPath, changedFile);
      if (normalized === null) {
        return earlyResult({
          outcome: "REFUSED",
          detail: "The changed-file list contains an unsafe or out-of-sandbox path.",
        });
      }
      targetByKey.set(pathKey(normalized), normalized);
    }
    const targets = [...targetByKey.values()].toSorted();
    if (targets.length === 0) {
      return earlyResult({
        outcome: "UNSUPPORTED",
        detail: "The candidate has no explicit changed file for bounded analysis.",
      });
    }

    const scanArgs = this.scanArguments(targets);
    const argumentBytes = scanArgs.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8") + 1,
      0,
    );
    if (
      !Number.isSafeInteger(argumentBytes) ||
      argumentBytes > this.targetBounds.maxArgumentBytes
    ) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "The OpenGrep scan arguments exceeded the configured byte bound.",
      });
    }

    const initialTargets = await this.validateTargets(sandboxPath, targets);
    if (!initialTargets.ok) {
      return earlyResult({ outcome: "REFUSED", detail: initialTargets.detail });
    }

    const initialRules = await this.verifyRulesFile(sandboxPath);
    if (!initialRules.ok) {
      return earlyResult({ outcome: "REFUSED", detail: initialRules.detail });
    }
    if (initialRules.digest !== this.rulesetDigest) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "OpenGrep rule bytes and manifest did not match the configured audited digest.",
      });
    }

    const probe = await this.probe();
    if (!probe.available || probe.version !== OPEN_GREP_PINNED_VERSION) {
      return earlyResult({
        outcome: "UNAVAILABLE",
        detail: probe.detail,
      });
    }

    const launchTargets = await this.validateTargets(sandboxPath, targets);
    if (!launchTargets.ok) {
      return earlyResult({ outcome: "REFUSED", detail: launchTargets.detail });
    }
    if (!this.sameTargets(initialTargets.targets, launchTargets.targets)) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "An explicit changed-file target changed before analysis launch.",
      });
    }
    const launchRules = await this.verifyRulesFile(sandboxPath);
    if (!launchRules.ok) {
      return earlyResult({ outcome: "REFUSED", detail: launchRules.detail });
    }
    if (launchRules.digest !== this.rulesetDigest || launchRules.digest !== initialRules.digest) {
      return earlyResult({
        outcome: "REFUSED",
        detail: "OpenGrep rules changed before analysis launch.",
      });
    }

    let processResult: BoundedProcessResult;
    try {
      processResult = await this.runner.run({
        command: this.command,
        args: scanArgs,
        cwd: sandboxPath,
        timeoutMs: this.timeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch {
      return earlyResult({
        outcome: "PROCESS_ERROR",
        exitCode: null,
        detail: "OpenGrep process runner failed before returning structural process evidence.",
      });
    }

    if (processResult.timedOut) {
      return earlyResult(
        { outcome: "TIMED_OUT", timeoutMs: this.timeoutMs },
        processResult.durationMs,
      );
    }
    if (processResult.aborted) {
      return earlyResult(
        { outcome: "REFUSED", detail: "Execution was cancelled during analysis." },
        processResult.durationMs,
      );
    }
    if (processResult.outputLimitExceeded) {
      return earlyResult(
        { outcome: "MALFORMED_OUTPUT", detail: "Provider output exceeded the runner's bound." },
        processResult.durationMs,
      );
    }
    if (processResult.spawnError !== undefined || processResult.exitCode !== 0) {
      return earlyResult(
        {
          outcome: "PROCESS_ERROR",
          exitCode: processResult.exitCode,
          detail: diagnosticDetail("OpenGrep analysis failed", processResult),
        },
        processResult.durationMs,
      );
    }

    const finalTargets = await this.validateTargets(sandboxPath, targets);
    if (!finalTargets.ok) {
      return earlyResult(
        { outcome: "REFUSED", detail: finalTargets.detail },
        processResult.durationMs,
      );
    }
    if (!this.sameTargets(launchTargets.targets, finalTargets.targets)) {
      return earlyResult(
        {
          outcome: "REFUSED",
          detail:
            "An explicit changed-file target changed during analysis; results were discarded.",
        },
        processResult.durationMs,
      );
    }

    const finalRules = await this.verifyRulesFile(sandboxPath);
    if (!finalRules.ok) {
      return earlyResult(
        { outcome: "REFUSED", detail: finalRules.detail },
        processResult.durationMs,
      );
    }
    if (finalRules.digest !== this.rulesetDigest || finalRules.digest !== launchRules.digest) {
      return earlyResult(
        {
          outcome: "REFUSED",
          detail: "OpenGrep rules changed during analysis; provider findings were discarded.",
        },
        processResult.durationMs,
      );
    }

    const decision = this.parseOutput(processResult.stdout, sandboxPath, launchTargets.targets);
    if (!decision.ok) {
      return earlyResult(decision.execution, processResult.durationMs);
    }
    return this.result(
      input,
      invokedAt,
      processResult.durationMs,
      { outcome: "COMPLETED", exitCode: 0 },
      decision.output,
    );
  }

  private scanArguments(targets: readonly string[]): string[] {
    return [
      "scan",
      "--json",
      "--quiet",
      "--disable-version-check",
      "--strict",
      "--no-error",
      "--no-autofix",
      "--disable-nosem",
      "--no-rewrite-rule-ids",
      "--taint-intrafile",
      "--config",
      this.rulesPath,
      "--",
      ...targets,
    ];
  }

  private async validateTargets(
    sandboxPath: string,
    targets: readonly string[],
  ): Promise<TargetValidation> {
    try {
      const canonicalSandboxPath = await realpath(sandboxPath);
      const targetsByKey = new Map<string, ValidatedTarget>();
      for (const candidatePath of targets) {
        const absolutePath = resolve(sandboxPath, candidatePath);
        const pathStat = await lstat(absolutePath);
        if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
          return {
            ok: false,
            detail: "Each changed-file target must be an existing regular non-symlink file.",
          };
        }
        if (pathStat.size > this.targetBounds.maxFileBytes) {
          return {
            ok: false,
            detail: "A changed-file target exceeded the configured file-size bound.",
          };
        }
        const canonicalPath = await realpath(absolutePath);
        if (
          !isWithin(canonicalSandboxPath, canonicalPath) ||
          canonicalPath === canonicalSandboxPath
        ) {
          return {
            ok: false,
            detail: "A changed-file target resolved outside the candidate sandbox.",
          };
        }
        const canonicalStat = await lstat(canonicalPath);
        if (!canonicalStat.isFile() || !sameFileIdentity(pathStat, canonicalStat)) {
          return {
            ok: false,
            detail: "A changed-file target changed while its canonical path was validated.",
          };
        }
        targetsByKey.set(pathKey(candidatePath), {
          candidatePath,
          canonicalPath,
          dev: pathStat.dev,
          ino: pathStat.ino,
          size: pathStat.size,
          mtimeMs: pathStat.mtimeMs,
          ctimeMs: pathStat.ctimeMs,
        });
      }
      return { ok: true, targets: targetsByKey };
    } catch {
      return {
        ok: false,
        detail: "Each changed-file target must be an existing regular file inside the sandbox.",
      };
    }
  }

  private sameTargets(
    initial: ReadonlyMap<string, ValidatedTarget>,
    launch: ReadonlyMap<string, ValidatedTarget>,
  ): boolean {
    if (initial.size !== launch.size) return false;
    for (const [key, initialTarget] of initial) {
      const launchTarget = launch.get(key);
      if (
        launchTarget === undefined ||
        launchTarget.candidatePath !== initialTarget.candidatePath ||
        pathKey(launchTarget.canonicalPath) !== pathKey(initialTarget.canonicalPath) ||
        launchTarget.dev !== initialTarget.dev ||
        launchTarget.ino !== initialTarget.ino ||
        launchTarget.size !== initialTarget.size ||
        launchTarget.mtimeMs !== initialTarget.mtimeMs ||
        launchTarget.ctimeMs !== initialTarget.ctimeMs
      ) {
        return false;
      }
    }
    return true;
  }

  private async verifyRulesFile(sandboxPath: string): Promise<RulesVerification> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const pathBefore = await lstat(this.rulesPath);
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath must name one regular non-symlink local file.",
        };
      }
      if (pathBefore.size > this.rulesetBounds.maxFileBytes) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath exceeded the configured file-size bound.",
        };
      }

      const [canonicalRulesPath, canonicalSandboxPath] = await Promise.all([
        realpath(this.rulesPath),
        realpath(sandboxPath),
      ]);
      if (isWithin(canonicalSandboxPath, canonicalRulesPath)) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath resolved inside the candidate sandbox.",
        };
      }

      handle = await open(this.rulesPath, "r");
      const handleBefore = await handle.stat();
      if (!handleBefore.isFile() || !sameFileIdentity(pathBefore, handleBefore)) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath changed while it was being opened.",
        };
      }
      if (handleBefore.size > this.rulesetBounds.maxFileBytes) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath exceeded the configured file-size bound before read.",
        };
      }
      const ruleBytes = await this.readExactRuleBytes(handle, handleBefore.size);
      if (ruleBytes === null) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath changed while its bounded bytes were being read.",
        };
      }
      const handleAfter = await handle.stat();
      const pathAfter = await lstat(this.rulesPath);
      if (
        !handleAfter.isFile() ||
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        !sameFileIdentity(handleBefore, handleAfter) ||
        !sameFileIdentity(handleAfter, pathAfter) ||
        handleBefore.size !== handleAfter.size ||
        handleAfter.size !== ruleBytes.byteLength ||
        handleBefore.mtimeMs !== handleAfter.mtimeMs ||
        handleBefore.ctimeMs !== handleAfter.ctimeMs
      ) {
        return {
          ok: false,
          detail: "OpenGrep rulesPath changed while its exact bytes were being read.",
        };
      }

      return { ok: true, digest: digestRuleset(ruleBytes, this.canonicalManifest) };
    } catch {
      return {
        ok: false,
        detail: "OpenGrep rulesPath could not be read as one regular non-symlink local file.",
      };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readExactRuleBytes(
    handle: Awaited<ReturnType<typeof open>>,
    expectedSize: number,
  ): Promise<Buffer | null> {
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === expectedSize ? buffer.subarray(0, expectedSize) : null;
  }

  private async performProbe(): Promise<CapabilityProbe> {
    let result: BoundedProcessResult;
    try {
      result = await this.runner.run({
        command: this.command,
        args: ["--version", "--disable-version-check"],
        cwd: dirname(this.command),
        timeoutMs: this.probeTimeoutMs,
      });
    } catch {
      return {
        available: false,
        version: null,
        detail: "OpenGrep version probe failed before returning process evidence.",
      };
    }
    if (result.timedOut) {
      return {
        available: false,
        version: null,
        detail: `OpenGrep version probe timed out after ${this.probeTimeoutMs}ms.`,
      };
    }
    if (result.aborted || result.outputLimitExceeded || result.spawnError !== undefined) {
      return {
        available: false,
        version: null,
        detail: "OpenGrep version probe did not complete within its execution contract.",
      };
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        version: null,
        detail: diagnosticDetail("OpenGrep version probe failed", result),
      };
    }
    const version = result.stdout.trim();
    if (version !== OPEN_GREP_PINNED_VERSION) {
      return {
        available: false,
        version: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ? version : null,
        detail: `OpenGrep must be exactly version ${OPEN_GREP_PINNED_VERSION}.`,
      };
    }
    return {
      available: true,
      version,
      detail: `OpenGrep ${version} is available.`,
    };
  }

  private parseOutput(
    stdout: string,
    sandboxPath: string,
    validatedTargets: ReadonlyMap<string, ValidatedTarget>,
  ): OutputDecision {
    let document: unknown;
    try {
      document = JSON.parse(stdout) as unknown;
    } catch {
      return malformed("Provider stdout was not valid JSON.");
    }
    if (!isRecord(document)) return malformed("Provider JSON root was not an object.");
    if (document.version !== OPEN_GREP_PINNED_VERSION) {
      return malformed("Provider JSON version did not match the pinned executable version.");
    }
    if (!Array.isArray(document.errors)) return malformed("Provider JSON errors was not an array.");
    if (document.errors.length > 0) {
      return {
        ok: false,
        execution: {
          outcome: "PROCESS_ERROR",
          exitCode: 0,
          detail: `OpenGrep reported ${document.errors.length} scan error(s).`,
        },
      };
    }
    if (!Array.isArray(document.skipped_rules)) {
      return malformed("Provider JSON skipped_rules was not an array.");
    }
    if (document.skipped_rules.length > 0) {
      return {
        ok: false,
        execution: {
          outcome: "PROCESS_ERROR",
          exitCode: 0,
          detail: `OpenGrep reported ${document.skipped_rules.length} skipped rule(s).`,
        },
      };
    }
    if (
      document.interfile_languages_used !== undefined &&
      (!Array.isArray(document.interfile_languages_used) ||
        document.interfile_languages_used.length > 0)
    ) {
      return malformed("Provider JSON claimed unexpected interfile analysis.");
    }
    if (!isRecord(document.paths) || !Array.isArray(document.paths.scanned)) {
      return malformed("Provider JSON paths.scanned was not an array.");
    }
    if (!Array.isArray(document.results)) {
      return malformed("Provider JSON results was not an array.");
    }

    const scannedByKey = new Map<string, string>();
    for (const rawPath of document.paths.scanned) {
      if (typeof rawPath !== "string") return malformed("A scanned path was not text.");
      const normalized = normalizeReportedFile(sandboxPath, rawPath);
      if (normalized === null) return malformed("A scanned path escaped the candidate sandbox.");
      const key = pathKey(normalized);
      const validatedTarget = validatedTargets.get(key);
      if (validatedTarget === undefined) {
        return malformed("Provider reported a scanned file outside the explicit changed-file set.");
      }
      if (scannedByKey.has(key)) return malformed("Provider reported a duplicate scanned file.");
      scannedByKey.set(key, validatedTarget.candidatePath);
    }

    const findings: CapabilityFinding[] = [];
    for (const rawFinding of document.results) {
      if (!isRecord(rawFinding) || !isNonEmptyText(rawFinding.check_id)) {
        return malformed("A provider finding lacked a rule ID.");
      }
      const rule = this.rules.get(rawFinding.check_id);
      if (rule === undefined) return malformed("Provider reported an unmanifested rule ID.");
      if (!isNonEmptyText(rawFinding.path)) return malformed("A provider finding lacked a path.");
      const normalizedPath = normalizeReportedFile(sandboxPath, rawFinding.path);
      if (normalizedPath === null)
        return malformed("A finding path escaped the candidate sandbox.");
      const key = pathKey(normalizedPath);
      const candidatePath = validatedTargets.get(key)?.candidatePath;
      if (candidatePath === undefined || !scannedByKey.has(key)) {
        return malformed("A finding was not bound to an explicitly scanned changed file.");
      }
      const candidateClass = languageClassOf(candidatePath);
      if (!rule.languageClasses.has(candidateClass)) {
        return malformed("A rule reported a finding outside its manifest language classes.");
      }
      if (!isRecord(rawFinding.start) || !isPositiveInteger(rawFinding.start.line)) {
        return malformed("A provider finding lacked a positive start line.");
      }
      if (!isRecord(rawFinding.extra) || !isNonEmptyText(rawFinding.extra.message)) {
        return malformed("A provider finding lacked required extra data.");
      }
      if (
        rawFinding.extra.is_ignored !== undefined &&
        typeof rawFinding.extra.is_ignored !== "boolean"
      ) {
        return malformed("A provider finding had an invalid ignored marker.");
      }
      const severity = normalizeSeverity(rawFinding.extra.severity);
      if (severity === null || severity !== rule.severity) {
        return malformed("A provider finding severity disagreed with the trusted manifest.");
      }
      if (rawFinding.extra.is_ignored === true) continue;

      findings.push({
        target: rule.target,
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: candidatePath,
        line: rawFinding.start.line,
        ruleId: rawFinding.check_id,
        message: rule.message,
        severity: rule.severity,
      });
    }

    const coverage: Partial<Record<LanguageClass, AnalysisCoverage>> = {};
    const targets = [...validatedTargets.values()].map((target) => target.candidatePath);
    for (const candidateClass of languageClasses) {
      const files = targets.filter((target) => languageClassOf(target) === candidateClass);
      if (files.length === 0) continue;
      if (!this.applicableClasses.has(candidateClass)) {
        coverage[candidateClass] = "UNSUPPORTED";
        continue;
      }
      const scannedCount = files.filter((file) => scannedByKey.has(pathKey(file))).length;
      coverage[candidateClass] =
        scannedCount === files.length ? "FULL" : scannedCount === 0 ? "UNSUPPORTED" : "PARTIAL";
    }

    return {
      ok: true,
      output: {
        findings,
        analyzedFiles: [...scannedByKey.values()].toSorted(),
        coverage,
      },
    };
  }

  private result(
    input: CapabilityInput,
    invokedAt: string,
    durationMs: number,
    execution: ProviderExecution,
    output?: ParsedOutput,
  ): CapabilityResult {
    return {
      provenance: {
        capabilityId: this.capabilityId,
        providerName: this.name,
        providerVersion: OPEN_GREP_PINNED_VERSION,
        rulesetDigest: this.rulesetDigest,
        invokedAt,
        durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
        candidateId: input.candidateId,
        diffDigest: input.diffDigest,
        baseRevision: input.sandbox.baseRevision,
      },
      execution,
      findings: output?.findings ?? [],
      coverage: output?.coverage ?? {},
      negativeCoverage: unsupportedNegativeCoverage(),
      analyzedFiles: output?.analyzedFiles ?? [],
    };
  }
}
