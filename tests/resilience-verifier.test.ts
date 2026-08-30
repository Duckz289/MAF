import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ResilienceVerifyInput } from "../src/domain/ports";
import type { ResilienceRelevanceEvidence } from "../src/domain/resilience";
import { CommandResilienceVerifier } from "../src/infrastructure/resilience-verifier";
import type { ProcessResult } from "../src/infrastructure/process-utils";

/**
 * Real-subprocess coverage for the M10 fault-injection boundary (a mocked port cannot lie about
 * what actually reaches the child process). These tests pin the contract the whole design rests
 * on: the scenario name reaches the command via MAF_RESILIENCE_SCENARIO, failures map to FAILED
 * with exit codes and output tails, timeouts bound execution, and cancellation kills in-flight
 * scenarios promptly instead of awaiting their timeout.
 */

const workdirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    workdirs.map((dir) =>
      import("node:fs/promises")
        .then((fs) => fs.rm(dir, { recursive: true, force: true }))
        .catch(() => undefined),
    ),
  );
});

const workdir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "maf-resilience-"));
  workdirs.push(dir);
  return dir;
};

const relevanceFor = (scenarios: string[]): ResilienceRelevanceEvidence => ({
  scenarios: scenarios as never,
  evidence: ["fixture relevance"],
  uninspectable: false,
});

const inputFor = async (
  command: string,
  scenarios: string[],
  overrides: {
    timeoutMs?: number;
    signal?: AbortSignal;
    specScenarios?: string[];
    evidenceInputs?: string[];
    composeFile?: string;
  } = {},
): Promise<ResilienceVerifyInput> => {
  const dir = await workdir();
  await writeFile(path.join(dir, "probe.txt"), "candidate workspace\n", "utf8");
  return {
    run: { id: "run-1" } as never,
    task: {
      repositoryPath: dir,
      resilience: {
        command,
        ...(overrides.specScenarios ? { scenarios: overrides.specScenarios as never } : {}),
        ...(overrides.evidenceInputs ? { evidenceInputs: overrides.evidenceInputs } : {}),
        ...(overrides.composeFile ? { composeFile: overrides.composeFile } : {}),
        ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      },
    } as never,
    sandbox: { path: dir } as never,
    candidateId: "candidate-1",
    diffDigest: "digest-1",
    relevance: relevanceFor(scenarios),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
};

describe("CommandResilienceVerifier (real subprocesses)", () => {
  const verifier = new CommandResilienceVerifier();

  it("delivers the scenario name to the trusted command via MAF_RESILIENCE_SCENARIO", async () => {
    // The command fails with a distinctive exit code unless it sees the expected env value â€” a
    // typo in the env name inside the verifier cannot pass this test.
    const command =
      "node -e \"process.exit(process.env.MAF_RESILIENCE_SCENARIO === 'TIMEOUT' ? 0 : 42)\"";
    const measurement = await verifier.verify(
      await inputFor(command, ["TIMEOUT", "RATE_LIMITING"]),
    );
    expect(measurement.state).toBe("EXECUTED");
    expect(measurement.candidateId).toBe("candidate-1");
    expect(measurement.diffDigest).toBe("digest-1");
    expect(measurement.scenarios.map((result) => [result.scenario, result.outcome])).toEqual([
      ["TIMEOUT", "PASSED"],
      ["RATE_LIMITING", "FAILED"],
    ]);
    expect(measurement.scenarios[1]?.exitCode).toBe(42);
  });

  it("executes only the scenarios the spec allowlists when spec.scenarios is set", async () => {
    const command =
      "node -e \"process.exit(process.env.MAF_RESILIENCE_SCENARIO === 'RATE_LIMITING' ? 0 : 42)\"";
    const measurement = await verifier.verify(
      await inputFor(command, ["TIMEOUT", "RATE_LIMITING"], { specScenarios: ["RATE_LIMITING"] }),
    );
    expect(measurement.state).toBe("EXECUTED");
    expect(measurement.scenarios.map((result) => result.scenario)).toEqual(["RATE_LIMITING"]);
    expect(measurement.scenarios[0]?.outcome).toBe("PASSED");
  });

  it("records command output tails as scenario evidence", async () => {
    const command = "node -e \"console.error('scenario failure detail'); process.exit(7)\"";
    const measurement = await verifier.verify(await inputFor(command, ["TIMEOUT"]));
    expect(measurement.scenarios[0]?.outcome).toBe("FAILED");
    expect(measurement.scenarios[0]?.evidence.join(" ")).toContain("scenario failure detail");
  });

  it("maps a timed-out scenario to FAILED with bounded duration, never a hang", async () => {
    const command = 'node -e "setTimeout(() => {}, 30000)"';
    const measurement = await verifier.verify(
      await inputFor(command, ["TIMEOUT"], { timeoutMs: 1_500 }),
    );
    expect(measurement.state).toBe("EXECUTED");
    expect(measurement.scenarios[0]?.outcome).toBe("FAILED");
    expect(measurement.scenarios[0]?.evidence.join(" ")).toContain("timed out");
  });

  it("kills an in-flight scenario promptly when the run is cancelled mid-sweep", async () => {
    const controller = new AbortController();
    const command = 'node -e "setTimeout(() => {}, 30000)"';
    const input = await inputFor(command, ["TIMEOUT", "CONNECTION_RESET"], {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const verification = verifier.verify(input);
    // Abort while the first (30s) scenario is in flight: runProcess must terminate the tree
    // quickly instead of waiting out the full timeout.
    setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    await expect(verification).rejects.toThrow(/cancelled/iu);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("returns NOT_CHECKED without running anything when no spec is configured", async () => {
    const dir = await workdir();
    const measurement = await verifier.verify({
      run: { id: "run-1" } as never,
      task: { repositoryPath: dir } as never,
      sandbox: { path: dir } as never,
      candidateId: "candidate-1",
      diffDigest: "digest-1",
      relevance: relevanceFor(["TIMEOUT"]),
    });
    expect(measurement.state).toBe("NOT_CHECKED");
    expect(measurement.evidence.join(" ")).toContain("no resilience verification specification");
  });

  it("invalidates evidence when a declared gitignored execution input changes", async () => {
    const input = await inputFor(
      "node -e \"require('node:fs').writeFileSync('generated-fault.json', 'changed')\"",
      ["TIMEOUT"],
      { evidenceInputs: ["generated-fault.json"] },
    );
    await writeFile(path.join(input.sandbox.path, "generated-fault.json"), "initial", "utf8");

    const measurement = await verifier.verify(input);

    expect(measurement.state).toBe("NOT_CHECKED");
    expect(measurement.evidence.join(" ")).toContain("execution inputs changed");
  });

  it("confines Compose execution to the candidate sandbox configuration", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const successful = async (
      command: string,
      args: string[],
      options: { cwd: string },
    ): Promise<ProcessResult> => {
      calls.push({ command, args, cwd: options.cwd });
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        aborted: false,
        signal: null,
      };
    };
    const composedVerifier = new CommandResilienceVerifier(successful);
    const input = await inputFor("fixture-command", ["TIMEOUT"], {
      composeFile: "ops/compose.yaml",
    });
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(input.sandbox.path, "ops"), { recursive: true });
    await fs.writeFile(path.join(input.sandbox.path, "ops", "compose.yaml"), "services: {}\n");

    const measurement = await composedVerifier.verify(input);

    expect(measurement.state).toBe("EXECUTED");
    const composeCalls = calls.filter((call) => call.command === "docker");
    expect(composeCalls).toHaveLength(2);
    expect(composeCalls.every((call) => call.cwd === input.sandbox.path)).toBe(true);
    expect(
      composeCalls.every(
        (call) => call.args[2] === path.join(input.sandbox.path, "ops/compose.yaml"),
      ),
    ).toBe(true);
  });

  it("rejects declared inputs that escape the candidate sandbox", async () => {
    const measurement = await verifier.verify(
      await inputFor("fixture-command", ["TIMEOUT"], { evidenceInputs: ["../outside.env"] }),
    );
    expect(measurement.state).toBe("NOT_CHECKED");
    expect(measurement.evidence.join(" ")).toContain("escapes the candidate sandbox");
  });
});
