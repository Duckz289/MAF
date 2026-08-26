import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
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
import type { LanguageClass } from "../../domain/capability-adequacy";

export const OSV_SCANNER_PINNED_VERSION = "2.5.1";

const capabilityId = "SECURITY.DEPENDENCY_VULNERABILITY_SCAN" satisfies CapabilityId;
const providerName = "osv-scanner";
const defaultProbeTimeoutMs = 5_000;
const maxChangedFiles = 10_000;
const maxLockfiles = 64;
const maxLockfileBytes = 25 * 1024 * 1024;
const maxTrustedConfigBytes = 64 * 1024;
const maxAcceptedOutputCharacters = 8 * 1024 * 1024;
const maxPackages = 100_000;
const maxFindings = 10_000;

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

export interface OsvScannerAdapterConfig {
  /** Absolute path to the separately installed, operator-verified executable. */
  command: string;
  /** Absolute path to a comment-only MAF-owned TOML file that overrides candidate configuration. */
  trustedConfigPath: string;
  timeoutMs: number;
  probeTimeoutMs?: number;
  runner: BoundedProcessRunner;
  now?: () => Date;
}

interface PreparedLockfile {
  absolutePath: string;
  relativePath: string;
}

interface PreparedInput {
  sandboxPath: string;
  trustedConfigPath: string;
  lockfiles: PreparedLockfile[];
}

interface ParsedOutput {
  findings: CapabilityFinding[];
  analyzedFiles: string[];
}

type PreparationDecision =
  | { ok: true; input: PreparedInput }
  | { ok: false; execution: ProviderExecution };

type OutputDecision =
  | { ok: true; output: ParsedOutput }
  | { ok: false; execution: ProviderExecution };

const languageClasses = [
  "TS_JS",
  "PYTHON",
  "SHELL",
  "GENERIC_SCRIPTING",
  "BOUNDED_COMPILED",
  "UNMODELLED",
  "CONFIG_WORKFLOW",
] as const satisfies readonly LanguageClass[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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

const hasUnsafeRelativePath = (value: string): boolean => {
  if (
    !isNonEmptyText(value) ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    looksLikeUncPath(value)
  ) {
    return true;
  }
  return value.replaceAll("\\", "/").split("/").includes("..");
};

const normalizeCandidateFile = (sandboxPath: string, file: string): string | null => {
  if (hasUnsafeRelativePath(file)) return null;
  const absolute = resolve(sandboxPath, file.replaceAll("/", sep).replaceAll("\\", sep));
  if (!isWithin(sandboxPath, absolute) || absolute === sandboxPath) return null;
  const normalized = toPortablePath(relative(sandboxPath, absolute));
  return normalized.length > 0 ? normalized : null;
};

const unsupportedNegativeCoverage = (): Record<LanguageClass, AnalysisCoverage> =>
  Object.fromEntries(
    languageClasses.map((languageClass) => [languageClass, "UNSUPPORTED"]),
  ) as Record<LanguageClass, AnalysisCoverage>;

const malformed = (detail: string): OutputDecision => ({
  ok: false,
  execution: { outcome: "MALFORMED_OUTPUT", detail },
});

const safeDuration = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);

const processResultIsValid = (value: unknown): value is BoundedProcessResult =>
  isRecord(value) &&
  (value.exitCode === null ||
    (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
  typeof value.stdout === "string" &&
  typeof value.stderr === "string" &&
  typeof value.durationMs === "number" &&
  typeof value.timedOut === "boolean" &&
  typeof value.aborted === "boolean" &&
  typeof value.outputLimitExceeded === "boolean" &&
  (value.spawnError === undefined || typeof value.spawnError === "string");

const severityFor = (value: string): CapabilityFinding["severity"] => {
  if (value.trim().length === 0) return "INFO";
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 10) return "INFO";
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "INFO";
};

const optionalArray = (value: unknown): unknown[] | null => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
};

const sourcePathFor = (sandboxPath: string, reportedPath: string): string | null => {
  if (!isNonEmptyText(reportedPath) || reportedPath.includes("\0") || looksRemote(reportedPath)) {
    return null;
  }
  const nativePath = reportedPath.replaceAll("/", sep).replaceAll("\\", sep);
  const absolute = isAbsolute(nativePath) ? resolve(nativePath) : resolve(sandboxPath, nativePath);
  return isWithin(sandboxPath, absolute) && absolute !== sandboxPath ? absolute : null;
};

export class OsvScannerAdapter implements CapabilityProvider {
  readonly capabilityId = capabilityId;
  readonly name = providerName;

  private readonly command: string;
  private readonly trustedConfigPath: string;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly runner: BoundedProcessRunner;
  private readonly now: () => Date;
  private probePromise: Promise<CapabilityProbe> | undefined;

  constructor(config: OsvScannerAdapterConfig) {
    assertAbsoluteLocalPath("OSV-Scanner command", config.command);
    assertAbsoluteLocalPath("OSV-Scanner trustedConfigPath", config.trustedConfigPath);
    assertPositiveTimeout("OSV-Scanner timeoutMs", config.timeoutMs);
    const probeTimeoutMs = config.probeTimeoutMs ?? defaultProbeTimeoutMs;
    assertPositiveTimeout("OSV-Scanner probeTimeoutMs", probeTimeoutMs);
    this.command = resolve(config.command);
    this.trustedConfigPath = resolve(config.trustedConfigPath);
    this.timeoutMs = config.timeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.runner = config.runner;
    this.now = config.now ?? (() => new Date());
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

    const preparation = await this.prepareInput(input);
    if (!preparation.ok) return earlyResult(preparation.execution);

    const probe = await this.probe();
    if (!probe.available || probe.version !== OSV_SCANNER_PINNED_VERSION) {
      return earlyResult({ outcome: "UNAVAILABLE", detail: probe.detail });
    }

    let rawProcessResult: unknown;
    try {
      rawProcessResult = await this.runner.run({
        command: this.command,
        args: [
          "scan",
          "source",
          "--format=json",
          "--verbosity=error",
          "--all-packages",
          "--all-vulns",
          "--no-resolve",
          "--no-call-analysis=all",
          `--config=${preparation.input.trustedConfigPath}`,
          ...preparation.input.lockfiles.map((lockfile) => `--lockfile=${lockfile.absolutePath}`),
        ],
        cwd: preparation.input.sandboxPath,
        timeoutMs: this.timeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch {
      return earlyResult({
        outcome: "PROCESS_ERROR",
        exitCode: null,
        detail: "OSV-Scanner process runner failed before returning structural process evidence.",
      });
    }

    if (!processResultIsValid(rawProcessResult)) {
      return earlyResult({
        outcome: "PROCESS_ERROR",
        exitCode: null,
        detail: "OSV-Scanner process runner returned malformed structural process evidence.",
      });
    }
    const processResult = rawProcessResult;
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
        {
          outcome: "MALFORMED_OUTPUT",
          detail: "Provider output exceeded the bounded process runner's limit.",
        },
        processResult.durationMs,
      );
    }
    if (processResult.spawnError !== undefined || processResult.exitCode === null) {
      return earlyResult(
        {
          outcome: "PROCESS_ERROR",
          exitCode: processResult.exitCode,
          detail: "OSV-Scanner analysis process could not be started.",
        },
        processResult.durationMs,
      );
    }
    if (processResult.exitCode === 128) {
      return earlyResult(
        {
          outcome: "UNSUPPORTED",
          detail: "OSV-Scanner found no packages in the explicit lockfile.",
        },
        processResult.durationMs,
      );
    }
    if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      return earlyResult(
        {
          outcome: "PROCESS_ERROR",
          exitCode: processResult.exitCode,
          detail: `OSV-Scanner exited outside its result-code contract (${processResult.exitCode}).`,
        },
        processResult.durationMs,
      );
    }
    if (processResult.stderr.trim().length > 0) {
      return earlyResult(
        {
          outcome: "MALFORMED_OUTPUT",
          detail: "OSV-Scanner emitted error diagnostics with an otherwise successful result code.",
        },
        processResult.durationMs,
      );
    }
    if (
      processResult.stdout.length === 0 ||
      processResult.stdout.length > maxAcceptedOutputCharacters
    ) {
      return earlyResult(
        { outcome: "MALFORMED_OUTPUT", detail: "OSV-Scanner JSON output was empty or oversized." },
        processResult.durationMs,
      );
    }

    const decision = this.parseOutput(
      processResult.stdout,
      processResult.exitCode,
      preparation.input,
    );
    if (!decision.ok) return earlyResult(decision.execution, processResult.durationMs);
    return this.result(
      input,
      invokedAt,
      processResult.durationMs,
      { outcome: "COMPLETED", exitCode: processResult.exitCode },
      decision.output,
    );
  }

  private async performProbe(): Promise<CapabilityProbe> {
    let rawResult: unknown;
    try {
      rawResult = await this.runner.run({
        command: this.command,
        args: ["--version"],
        cwd: dirname(this.command),
        timeoutMs: this.probeTimeoutMs,
      });
    } catch {
      return {
        available: false,
        version: null,
        detail: "OSV-Scanner version probe failed before returning process evidence.",
      };
    }
    if (!processResultIsValid(rawResult)) {
      return {
        available: false,
        version: null,
        detail: "OSV-Scanner version probe returned malformed process evidence.",
      };
    }
    if (
      rawResult.timedOut ||
      rawResult.aborted ||
      rawResult.outputLimitExceeded ||
      rawResult.spawnError !== undefined ||
      rawResult.exitCode !== 0
    ) {
      return {
        available: false,
        version: null,
        detail: "OSV-Scanner version probe did not complete within its execution contract.",
      };
    }

    const lines = `${rawResult.stdout}\n${rawResult.stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const versionLines = lines.filter((line) => line.startsWith("osv-scanner version:"));
    if (versionLines.length !== 1) {
      return {
        available: false,
        version: null,
        detail: "OSV-Scanner version probe output was malformed.",
      };
    }
    const match = /^osv-scanner version:\s*(\S+)$/u.exec(lines[0] ?? "");
    const version = match?.[1] ?? null;
    if (version !== OSV_SCANNER_PINNED_VERSION) {
      return {
        available: false,
        version,
        detail: `OSV-Scanner must be exactly version ${OSV_SCANNER_PINNED_VERSION}.`,
      };
    }
    return {
      available: true,
      version,
      detail: `OSV-Scanner ${version} is available.`,
    };
  }

  private async prepareInput(input: CapabilityInput): Promise<PreparationDecision> {
    if (!isAbsolute(input.sandbox.path)) {
      return {
        ok: false,
        execution: { outcome: "REFUSED", detail: "Sandbox path is not absolute." },
      };
    }
    if (input.diff.changedFiles.length > maxChangedFiles) {
      return {
        ok: false,
        execution: { outcome: "REFUSED", detail: "Changed-file scope exceeded its bound." },
      };
    }

    let sandboxPath: string;
    try {
      sandboxPath = await realpath(resolve(input.sandbox.path));
      const sandboxMetadata = await stat(sandboxPath);
      if (!sandboxMetadata.isDirectory()) throw new Error("not a directory");
    } catch {
      return {
        ok: false,
        execution: { outcome: "REFUSED", detail: "Sandbox path was not a readable directory." },
      };
    }
    if (isWithin(sandboxPath, this.command) || isWithin(sandboxPath, this.trustedConfigPath)) {
      return {
        ok: false,
        execution: {
          outcome: "REFUSED",
          detail: "Executable and trusted configuration must be outside the candidate sandbox.",
        },
      };
    }

    let trustedConfigPath: string;
    try {
      const metadata = await lstat(this.trustedConfigPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > maxTrustedConfigBytes
      ) {
        throw new Error("untrusted config file shape");
      }
      trustedConfigPath = await realpath(this.trustedConfigPath);
      if (isWithin(sandboxPath, trustedConfigPath)) throw new Error("config inside sandbox");
      const contents = (await readFile(trustedConfigPath, "utf8")).replace(/^\uFEFF/u, "");
      if (
        contents
          .split(/\r?\n/u)
          .some((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"))
      ) {
        throw new Error("config contains directives");
      }
    } catch {
      return {
        ok: false,
        execution: {
          outcome: "REFUSED",
          detail: "MAF-owned scanner configuration was absent, unsafe, or not comment-only.",
        },
      };
    }

    const normalizedFiles = new Map<string, string>();
    for (const changedFile of input.diff.changedFiles) {
      const normalized = normalizeCandidateFile(sandboxPath, changedFile);
      if (normalized === null) {
        return {
          ok: false,
          execution: {
            outcome: "REFUSED",
            detail: "The changed-file list contains an unsafe or out-of-sandbox path.",
          },
        };
      }
      normalizedFiles.set(pathKey(normalized), normalized);
    }
    const candidates = [...normalizedFiles.values()]
      .filter((file) => file.split("/").at(-1) === "package-lock.json")
      .toSorted();
    if (candidates.length === 0) {
      return {
        ok: false,
        execution: {
          outcome: "UNSUPPORTED",
          detail: "The candidate has no explicit changed package-lock.json input.",
        },
      };
    }
    if (candidates.length > maxLockfiles) {
      return {
        ok: false,
        execution: { outcome: "REFUSED", detail: "Explicit lockfile scope exceeded its bound." },
      };
    }

    const lockfiles: PreparedLockfile[] = [];
    for (const relativePath of candidates) {
      const candidatePath = resolve(sandboxPath, relativePath.replaceAll("/", sep));
      try {
        const metadata = await lstat(candidatePath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          return {
            ok: false,
            execution: {
              outcome: "REFUSED",
              detail: "An explicit lockfile was not a regular non-symlink file.",
            },
          };
        }
        if (metadata.size > maxLockfileBytes) {
          return {
            ok: false,
            execution: {
              outcome: "REFUSED",
              detail: "An explicit lockfile exceeded its size bound.",
            },
          };
        }
        const absolutePath = await realpath(candidatePath);
        if (!isWithin(sandboxPath, absolutePath)) {
          return {
            ok: false,
            execution: { outcome: "REFUSED", detail: "An explicit lockfile escaped the sandbox." },
          };
        }
        lockfiles.push({ absolutePath, relativePath });
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
        return {
          ok: false,
          execution:
            code === "ENOENT"
              ? { outcome: "UNSUPPORTED", detail: "An explicit changed lockfile was absent." }
              : { outcome: "REFUSED", detail: "An explicit lockfile could not be validated." },
        };
      }
    }

    return { ok: true, input: { sandboxPath, trustedConfigPath, lockfiles } };
  }

  private parseOutput(stdout: string, exitCode: 0 | 1, prepared: PreparedInput): OutputDecision {
    let document: unknown;
    try {
      document = JSON.parse(stdout) as unknown;
    } catch {
      return malformed("Provider stdout was not valid JSON.");
    }
    if (!isRecord(document)) return malformed("Provider JSON root was not an object.");
    if (!Array.isArray(document.results))
      return malformed("Provider JSON results was not an array.");
    if (
      document.experimental_generic_findings !== undefined &&
      (!Array.isArray(document.experimental_generic_findings) ||
        document.experimental_generic_findings.length > 0)
    ) {
      return malformed("Provider JSON contained unsupported experimental findings.");
    }

    const targetByKey = new Map(
      prepared.lockfiles.map((lockfile) => [pathKey(lockfile.absolutePath), lockfile]),
    );
    const analyzedByKey = new Map<string, string>();
    const findings: CapabilityFinding[] = [];
    let packageCount = 0;
    let vulnerabilityCount = 0;

    for (const rawResult of document.results) {
      if (!isRecord(rawResult) || !isRecord(rawResult.source)) {
        return malformed("A provider result lacked source metadata.");
      }
      if (!isNonEmptyText(rawResult.source.path) || rawResult.source.type !== "lockfile") {
        return malformed("A provider result was not bound to a lockfile source.");
      }
      const reportedPath = sourcePathFor(prepared.sandboxPath, rawResult.source.path);
      if (reportedPath === null)
        return malformed("A provider source escaped the candidate sandbox.");
      const sourceKey = pathKey(reportedPath);
      const lockfile = targetByKey.get(sourceKey);
      if (lockfile === undefined) {
        return malformed("Provider reported a source outside the explicit lockfile set.");
      }
      if (analyzedByKey.has(sourceKey)) return malformed("Provider reported a duplicate source.");
      analyzedByKey.set(sourceKey, lockfile.relativePath);
      if (!Array.isArray(rawResult.packages)) {
        return malformed("A provider result packages field was not an array.");
      }

      packageCount += rawResult.packages.length;
      if (packageCount > maxPackages)
        return malformed("Provider package count exceeded its bound.");
      for (const rawPackage of rawResult.packages) {
        if (!isRecord(rawPackage) || !isRecord(rawPackage.package)) {
          return malformed("A provider package lacked package identity metadata.");
        }
        const packageInfo = rawPackage.package;
        if (
          typeof packageInfo.name !== "string" ||
          typeof packageInfo.version !== "string" ||
          typeof packageInfo.ecosystem !== "string" ||
          (packageInfo.commit !== undefined && typeof packageInfo.commit !== "string")
        ) {
          return malformed("A provider package identity had an invalid shape.");
        }
        const vulnerabilities = optionalArray(rawPackage.vulnerabilities);
        const groups = optionalArray(rawPackage.groups);
        if (vulnerabilities === null || groups === null) {
          return malformed("A provider package vulnerability data had an invalid shape.");
        }

        const vulnerabilityIds = new Set<string>();
        for (const vulnerability of vulnerabilities) {
          if (!isRecord(vulnerability) || !isNonEmptyText(vulnerability.id)) {
            return malformed("A vulnerability lacked a non-empty OSV ID.");
          }
          if (vulnerabilityIds.has(vulnerability.id)) {
            return malformed("A package repeated a vulnerability ID.");
          }
          vulnerabilityIds.add(vulnerability.id);
        }
        vulnerabilityCount += vulnerabilityIds.size;

        if (vulnerabilityIds.size === 0) {
          if (groups.length > 0)
            return malformed("A clean package contained vulnerability groups.");
          continue;
        }
        if (
          !isNonEmptyText(packageInfo.name) ||
          !isNonEmptyText(packageInfo.ecosystem) ||
          (!isNonEmptyText(packageInfo.version) && !isNonEmptyText(packageInfo.commit))
        ) {
          return malformed("A vulnerable package lacked a complete package coordinate.");
        }
        if (groups.length === 0)
          return malformed("Vulnerabilities were not covered by alias groups.");

        const groupedIds = new Set<string>();
        for (const group of groups) {
          if (!isRecord(group) || !Array.isArray(group.ids) || group.ids.length === 0) {
            return malformed("A vulnerability group lacked IDs.");
          }
          if (
            group.aliases !== undefined &&
            group.aliases !== null &&
            !Array.isArray(group.aliases)
          ) {
            return malformed("A vulnerability group aliases field had an invalid shape.");
          }
          if (typeof group.max_severity !== "string") {
            return malformed("A vulnerability group lacked max_severity.");
          }

          const groupIds = new Set<string>();
          for (const id of group.ids) {
            if (!isNonEmptyText(id) || !vulnerabilityIds.has(id) || groupedIds.has(id)) {
              return malformed("A vulnerability group contained an unknown or duplicate ID.");
            }
            groupIds.add(id);
            groupedIds.add(id);
          }
          if (groupIds.size !== group.ids.length) {
            return malformed("A vulnerability group repeated an ID.");
          }
          if (
            Array.isArray(group.aliases) &&
            group.aliases.some((alias) => !isNonEmptyText(alias))
          ) {
            return malformed("A vulnerability group contained an invalid alias.");
          }

          const ruleId = [...groupIds].toSorted()[0];
          if (ruleId === undefined) return malformed("A vulnerability group had no canonical ID.");
          findings.push({
            target: "SECURITY.DEPENDENCY_VULNERABILITY",
            claim: "POSITIVE_FINDING",
            strength: "STRUCTURAL",
            file: lockfile.relativePath,
            ruleId,
            message: `${packageInfo.ecosystem}:${packageInfo.name}@${packageInfo.version || packageInfo.commit} matches known advisory ${ruleId}`,
            severity: severityFor(group.max_severity),
          });
          if (findings.length > maxFindings) {
            return malformed("Provider finding count exceeded its bound.");
          }
        }
        if (groupedIds.size !== vulnerabilityIds.size) {
          return malformed("Not every vulnerability was represented by exactly one group.");
        }
      }
    }

    if (analyzedByKey.size !== targetByKey.size) {
      return malformed("Provider did not report every explicit lockfile source.");
    }
    if (packageCount === 0)
      return malformed("Successful result codes require at least one package.");
    if (exitCode === 0 && vulnerabilityCount > 0) {
      return malformed("Exit code 0 contradicted vulnerability-bearing JSON.");
    }
    if (exitCode === 1 && vulnerabilityCount === 0) {
      return malformed("Exit code 1 did not include a vulnerability finding.");
    }

    return {
      ok: true,
      output: {
        findings,
        analyzedFiles: [...analyzedByKey.values()].toSorted(),
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
    const completed = execution.outcome === "COMPLETED";
    return {
      provenance: {
        capabilityId: this.capabilityId,
        providerName: this.name,
        providerVersion: OSV_SCANNER_PINNED_VERSION,
        invokedAt,
        durationMs: safeDuration(durationMs),
        candidateId: input.candidateId,
        diffDigest: input.diffDigest,
        baseRevision: input.sandbox.baseRevision,
      },
      execution,
      findings: output?.findings ?? [],
      coverage: completed ? { UNMODELLED: "PARTIAL" } : {},
      negativeCoverage: unsupportedNegativeCoverage(),
      analyzedFiles: output?.analyzedFiles ?? [],
    };
  }
}
