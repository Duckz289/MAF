import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ResilienceVerifierPort, ResilienceVerifyInput } from "../domain/ports";
import type {
  ResilienceExecutionInputSnapshot,
  ResilienceMeasurement,
  ResilienceScenarioResult,
} from "../domain/resilience";
import { runProcess } from "./process-utils";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

const scenarioEnvName = "MAF_RESILIENCE_SCENARIO";

/** Bounded so a wedged compose stack can never hang the quality gate open-endedly. */
const composeTimeoutMs = 120_000;
const maxEvidenceInputs = 50;
const maxEvidenceInputBytes = 10 * 1024 * 1024;

const tail = (text: string, maxChars = 400): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(-maxChars)}…`;
};

/**
 * M10 trusted resilience fault-injection boundary. Runs the project's own trusted command once
 * per plan-relevant scenario in the candidate workspace, with `MAF_RESILIENCE_SCENARIO` set to
 * the scenario name so the project's fault harness decides how the fault is actually injected —
 * MAF never guesses how to break the candidate's dependencies. An optional `composeFile` brings
 * up a bounded ephemeral environment (`docker compose up -d --wait`, torn down afterwards);
 * Docker Compose is the ceiling — there is no Kubernetes path, by design.
 *
 * Everything here runs locally: a PASSED scenario is deterministic local evidence about the
 * candidate, never a claim of production verification.
 */
export class CommandResilienceVerifier implements ResilienceVerifierPort {
  constructor(private readonly processRunner: typeof runProcess = runProcess) {}

  async captureEvidenceInputs(
    input: ResilienceVerifyInput,
  ): Promise<ResilienceExecutionInputSnapshot> {
    const configured = [
      ...(input.task.resilience?.composeFile ? [input.task.resilience.composeFile] : []),
      ...(input.task.resilience?.evidenceInputs ?? []),
    ];
    const inputs = [...new Set(configured.map((file) => file.replaceAll("\\", "/")))].sort();
    if (inputs.length > maxEvidenceInputs) {
      throw new Error(`at most ${maxEvidenceInputs} resilience evidence inputs are allowed`);
    }
    const root = path.resolve(input.sandbox.path);
    const rootPrefix = `${root}${path.sep}`;
    const hash = createHash("sha256");
    for (const declared of inputs) {
      if (path.isAbsolute(declared)) {
        throw new Error(`resilience evidence input must be candidate-relative: ${declared}`);
      }
      const target = path.resolve(root, declared);
      if (target !== root && !target.startsWith(rootPrefix)) {
        throw new Error(`resilience evidence input escapes the candidate sandbox: ${declared}`);
      }
      hash.update(`path:${declared}\0`);
      try {
        const resolved = await realpath(target);
        if (resolved !== root && !resolved.startsWith(rootPrefix)) {
          throw new Error(
            `resilience evidence input resolves outside the candidate sandbox: ${declared}`,
          );
        }
        const metadata = await stat(resolved);
        if (!metadata.isFile()) {
          throw new Error(`resilience evidence input is not a regular file: ${declared}`);
        }
        if (metadata.size > maxEvidenceInputBytes) {
          throw new Error(
            `resilience evidence input exceeds ${maxEvidenceInputBytes} bytes: ${declared}`,
          );
        }
        hash.update("present\0");
        hash.update(await readFile(resolved));
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
        if (code !== "ENOENT") throw error;
        hash.update("missing\0");
      }
      hash.update("\0");
    }
    return { digest: hash.digest("hex"), inputs };
  }

  async verify(input: ResilienceVerifyInput): Promise<ResilienceMeasurement> {
    const spec = input.task.resilience;
    const notChecked = (evidence: string[]): ResilienceMeasurement => ({
      state: "NOT_CHECKED",
      candidateId: input.candidateId,
      diffDigest: input.diffDigest,
      scenarios: [],
      evidence,
    });
    if (!spec) {
      return notChecked([
        "no resilience verification specification was configured, so no fault scenario could be executed",
      ]);
    }
    const scenarios = spec.scenarios
      ? input.relevance.scenarios.filter((scenario) => spec.scenarios?.includes(scenario))
      : input.relevance.scenarios;

    let inputSnapshot: ResilienceExecutionInputSnapshot;
    try {
      inputSnapshot = await this.captureEvidenceInputs(input);
    } catch (error) {
      return notChecked([
        `resilience execution inputs could not be bound to the candidate sandbox: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    let composeStarted = false;
    const baseEvidence: string[] = [];
    try {
      if (spec.composeFile) {
        const composeFile = path.resolve(input.sandbox.path, spec.composeFile);
        const up = await this.processRunner(
          "docker",
          ["compose", "-f", composeFile, "up", "-d", "--wait"],
          {
            cwd: input.sandbox.path,
            timeoutMs: composeTimeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        if (up.exitCode !== 0) {
          return notChecked([
            `bounded ephemeral environment failed to start: ${tail(up.stderr) || tail(up.stdout)}`,
          ]);
        }
        composeStarted = true;
        baseEvidence.push(
          `ephemeral environment started from candidate-local ${spec.composeFile} via docker compose up -d --wait`,
        );
      }

      const shell = shellCommand();
      const results: ResilienceScenarioResult[] = [];
      for (const scenario of scenarios) {
        // Cancellation is honored mid-sweep, not just between awaits in the caller: stop starting
        // new scenarios and let the caller's cancelled-state recheck discard anything partial.
        if (input.signal?.aborted) throw new Error("Run cancelled during resilience verification");
        // powershell -Command collapses any nonzero native exit code to 1, which would flatten
        // the exit codes our evidence depends on; propagate the last native exit code explicitly.
        const command =
          process.platform === "win32" ? `${spec.command}; exit $LASTEXITCODE` : spec.command;
        const result = await this.processRunner(shell.command, [...shell.prefix, command], {
          cwd: input.sandbox.path,
          timeoutMs: spec.timeoutMs ?? 120_000,
          env: { [scenarioEnvName]: scenario },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        results.push({
          scenario,
          outcome: result.exitCode === 0 ? "PASSED" : "FAILED",
          exitCode: result.exitCode,
          evidence:
            result.exitCode === 0
              ? [tail(result.stdout) || "command exited 0"]
              : [tail(result.stderr) || tail(result.stdout) || `command exited ${result.exitCode}`],
        });
      }
      const afterInputs = await this.captureEvidenceInputs(input);
      if (afterInputs.digest !== inputSnapshot.digest) {
        return notChecked([
          "candidate resilience execution inputs changed while scenarios were running; evidence was invalidated",
        ]);
      }
      return {
        state: "EXECUTED",
        candidateId: input.candidateId,
        diffDigest: input.diffDigest,
        executionInputDigest: inputSnapshot.digest,
        executionInputs: inputSnapshot.inputs,
        scenarios: results,
        evidence: [
          `${scenarios.length} relevant scenario(s) executed with the configured trusted command (${scenarioEnvName} env carries the scenario name)`,
          ...baseEvidence,
          "scenarios ran in a bounded local environment; this is resilience evidence, not production verification",
        ],
      };
    } finally {
      if (composeStarted && spec.composeFile) {
        const composeFile = path.resolve(input.sandbox.path, spec.composeFile);
        await this.processRunner(
          "docker",
          ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"],
          {
            cwd: input.sandbox.path,
            timeoutMs: composeTimeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        ).catch(() => undefined);
      }
    }
  }
}
