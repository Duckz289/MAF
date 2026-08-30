import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Sandbox, SandboxDiff, VerifierPort } from "../domain/ports";
import type {
  Run,
  Task,
  Verification,
  VerificationEnvironmentBinding,
  VerifierExecutionEvidence,
} from "../domain/types";
import { verificationEnvironmentIdentity } from "../domain/verification-evidence";
import { normalizeVerificationSpecification } from "../domain/verification-spec";
import { runProcess, type ProcessResult } from "./process-utils";
import {
  materializeVerificationCandidate,
  type VerificationMaterialization,
} from "./verification-materialization";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

const safeExpectedFile = async (root: string, expectedFile: string): Promise<string> => {
  if (
    expectedFile.length === 0 ||
    expectedFile.includes("\0") ||
    path.posix.isAbsolute(expectedFile) ||
    path.win32.isAbsolute(expectedFile) ||
    /^[a-z]:/iu.test(expectedFile)
  ) {
    throw new Error("Expected file must be a normal repository-relative path");
  }
  const resolvedRoot = await realpath(root);
  const target = path.resolve(resolvedRoot, expectedFile);
  const relative = path.relative(resolvedRoot, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Expected file escapes the sandbox");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    throw new Error("Expected file cannot be resolved");
  }
  const canonicalRelative = path.relative(resolvedRoot, canonicalTarget);
  if (
    canonicalRelative === "" ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error("Expected file escapes the sandbox");
  }
  if (!(await stat(canonicalTarget)).isFile()) {
    throw new Error("Expected path is not a regular file");
  }
  return canonicalTarget;
};

const commandResolutionFailed = (
  shellCommandName: string,
  exitCode: number,
  output: string,
): boolean => {
  const lower = output.toLowerCase();
  if (lower.includes("commandnotfoundexception")) return true;
  if (/is not recognized as the name of a cmdlet/.test(lower)) return true;
  if (shellCommandName === "/bin/sh") {
    return exitCode === 127 || lower.includes("command not found");
  }
  return exitCode === 127 || exitCode === 9009;
};

const environmentBinding = (
  shell: string,
  materialization: VerificationMaterialization,
): VerificationEnvironmentBinding => {
  const withoutIdentity: Omit<VerificationEnvironmentBinding, "identity"> = {
    identityQuality: "BOUNDED",
    promotionAuthority: "BOUNDED_LOCAL",
    materialization: "FRESH_CANDIDATE_MATERIALIZATION",
    candidateContainment: "WORKSPACE_CONTAINED",
    gitMetadata: "EXCLUDED",
    filesystemIsolation: "FRESH_ROOT_WITH_STATIC_ESCAPE_GUARD",
    externalToolchain: "OPERATOR_PATH_ALLOWED",
    temporaryArtifacts: "DEDICATED_EXTERNAL_TEMP_ALLOWED",
    platform: process.platform,
    architecture: process.arch,
    harnessRuntime: process.version,
    shell,
    dependencyManifestDigests: materialization.dependencyManifestDigests,
    unknowns: [
      "operator toolchain bytes are identified by platform/runtime/shell semantics, not a supply-chain attestation",
      "host filesystem isolation is not OS-enforced; candidate symlink and explicit static path escapes are rejected",
    ],
  };
  return {
    ...withoutIdentity,
    identity: verificationEnvironmentIdentity(withoutIdentity),
  };
};

const insufficientEnvironment = (shell: string, reason: string): VerificationEnvironmentBinding => {
  const withoutIdentity: Omit<VerificationEnvironmentBinding, "identity"> = {
    identityQuality: "UNKNOWN",
    promotionAuthority: "INSUFFICIENT",
    materialization: "UNAVAILABLE",
    candidateContainment: "INSUFFICIENT",
    gitMetadata: "UNKNOWN",
    filesystemIsolation: "NOT_ESTABLISHED",
    externalToolchain: "UNKNOWN",
    temporaryArtifacts: "UNKNOWN",
    platform: process.platform,
    architecture: process.arch,
    harnessRuntime: process.version,
    shell,
    dependencyManifestDigests: [],
    unknowns: [reason],
  };
  return {
    ...withoutIdentity,
    identity: verificationEnvironmentIdentity(withoutIdentity),
  };
};

export class CommandVerifier implements VerifierPort {
  private readonly cancelled = new Set<string>();

  async verify(run: Run, task: Task, sandbox: Sandbox, diff: SandboxDiff): Promise<Verification> {
    const startedAt = new Date().toISOString();
    const specification = normalizeVerificationSpecification(task.verification);
    const shell = shellCommand();

    if (this.cancelled.has(run.id)) {
      return this.result({
        run,
        state: "CANCELLED",
        exitCode: 1,
        output: "Verification cancelled",
        startedAt,
        specificationIdentity: specification.identity,
      });
    }

    if (specification.status !== "CONFIGURED") {
      return this.result({
        run,
        state: "NOT_CHECKED",
        exitCode: 1,
        output:
          specification.status === "INVALID"
            ? `Verification specification is invalid: ${specification.invalidReasons.join("; ")}`
            : "Verification was not configured; captured candidate material is not proof of correctness",
        startedAt,
        specificationIdentity: specification.identity,
      });
    }

    let materialization: VerificationMaterialization;
    try {
      materialization = await materializeVerificationCandidate(sandbox, diff, diff.changedFiles);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.result({
        run,
        state: "NOT_CHECKED",
        exitCode: 1,
        output: `Verification environment could not be bounded: ${reason}`,
        startedAt,
        specificationIdentity: specification.identity,
        candidateDigest: diff.identityDigest,
        environment: insufficientEnvironment(shell.command, reason),
      });
    }

    const environment = materialization.bounded
      ? environmentBinding(shell.command, materialization)
      : insufficientEnvironment(
          shell.command,
          "the verifier input did not include a captured candidate manifest",
        );
    let exitCode = 0;
    let output = "";
    let execution: VerifierExecutionEvidence | undefined;
    try {
      if (specification.expectedFile) {
        try {
          await safeExpectedFile(materialization.rootPath, specification.expectedFile);
          output += `Found ${specification.expectedFile}`;
        } catch (error) {
          exitCode = 1;
          output += `${output ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (specification.command) {
        const timeoutMs = specification.timeoutMs ?? 120_000;
        execution = { shellSpawned: true, commandResolution: "RESOLVED", timeoutMs };
        let processResult: ProcessResult | undefined;
        try {
          processResult = await runProcess(
            shell.command,
            [...shell.prefix, specification.command],
            {
              cwd: materialization.rootPath,
              timeoutMs,
              env: {
                TEMP: materialization.externalTempPath,
                TMP: materialization.externalTempPath,
                TMPDIR: materialization.externalTempPath,
                MAF_VERIFICATION_WORKSPACE: materialization.rootPath,
                ...(materialization.operatorDependencyPaths.length > 0
                  ? {
                      NODE_PATH: materialization.operatorDependencyPaths.join(path.delimiter),
                      PATH: [
                        ...materialization.operatorDependencyPaths.map((root) =>
                          path.join(root, ".bin"),
                        ),
                        process.env.PATH,
                      ]
                        .filter((item): item is string => Boolean(item))
                        .join(path.delimiter),
                    }
                  : {}),
              },
              killProcessTree: true,
            },
          );
        } catch {
          processResult = undefined;
          execution = {
            shellSpawned: false,
            commandResolution: "SHELL_UNAVAILABLE",
            termination: "NOT_STARTED",
            timeoutMs,
          };
        }
        if (processResult !== undefined) {
          exitCode = Math.max(exitCode, processResult.exitCode);
          const combined = `${processResult.stdout}${processResult.stderr}`;
          output += `${output ? "\n" : ""}${combined}`.trimEnd();
          execution = {
            shellSpawned: true,
            commandResolution:
              processResult.exitCode !== 0 &&
              commandResolutionFailed(shell.command, processResult.exitCode, combined)
                ? "COMMAND_NOT_FOUND"
                : "RESOLVED",
            termination: processResult.timedOut
              ? "TIMED_OUT"
              : processResult.signal !== null
                ? "SIGNALLED"
                : "COMPLETED",
            ...(processResult.signal !== null ? { terminatingSignal: processResult.signal } : {}),
            durationMs: Math.round(processResult.durationMs),
            timeoutMs,
          };
        } else {
          exitCode = Math.max(exitCode, 1);
          output += `${output ? "\n" : ""}verifier shell "${shell.command}" could not be spawned`;
        }
      }

      return this.result({
        run,
        state: exitCode === 0 ? "VERIFIED" : "QUARANTINED",
        exitCode,
        output,
        startedAt,
        specificationIdentity: specification.identity,
        ...(materialization.candidateDigest
          ? { candidateDigest: materialization.candidateDigest }
          : {}),
        environment,
        execution,
        command: specification.command,
      });
    } finally {
      await materialization.cleanup();
    }
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  private result(input: {
    run: Run;
    state: Verification["state"];
    exitCode: number;
    output: string;
    startedAt: string;
    specificationIdentity: string;
    candidateDigest?: string | undefined;
    environment?: VerificationEnvironmentBinding | undefined;
    execution?: VerifierExecutionEvidence | undefined;
    command?: string | undefined;
  }): Verification {
    return {
      id: crypto.randomUUID(),
      runId: input.run.id,
      type: "normalized-local",
      state: input.state,
      ...(input.command ? { command: input.command } : {}),
      exitCode: input.exitCode,
      output: input.output.slice(0, 100_000),
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
      verificationSpecIdentity: input.specificationIdentity,
      ...(input.candidateDigest ? { candidateDigest: input.candidateDigest } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
    };
  }
}
