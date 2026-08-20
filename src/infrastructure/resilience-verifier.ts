import type { ResilienceMeasurement, ResilienceScenarioResult } from "../domain/resilience";
import type { ResilienceVerifyInput, ResilienceVerifierPort } from "../domain/ports";
import { runProcess } from "./process-utils";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

const scenarioEnvName = "MAF_RESILIENCE_SCENARIO";

/** Bounded so a wedged compose stack can never hang the quality gate open-endedly. */
const composeTimeoutMs = 120_000;

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

    let composeStarted = false;
    const baseEvidence: string[] = [];
    try {
      if (spec.composeFile) {
        const up = await runProcess(
          "docker",
          ["compose", "-f", spec.composeFile, "up", "-d", "--wait"],
          {
            cwd: input.task.repositoryPath,
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
          `ephemeral environment started from ${spec.composeFile} via docker compose up -d --wait`,
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
        const result = await runProcess(shell.command, [...shell.prefix, command], {
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
      return {
        state: "EXECUTED",
        candidateId: input.candidateId,
        diffDigest: input.diffDigest,
        scenarios: results,
        evidence: [
          `${scenarios.length} relevant scenario(s) executed with the configured trusted command (${scenarioEnvName} env carries the scenario name)`,
          ...baseEvidence,
          "scenarios ran in a bounded local environment; this is resilience evidence, not production verification",
        ],
      };
    } finally {
      if (composeStarted && spec.composeFile) {
        await runProcess(
          "docker",
          ["compose", "-f", spec.composeFile, "down", "-v", "--remove-orphans"],
          {
            cwd: input.task.repositoryPath,
            timeoutMs: composeTimeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        ).catch(() => undefined);
      }
    }
  }
}
