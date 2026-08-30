import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityInput } from "../src/domain/capability/provider";
import {
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type BoundedProcessRunner,
  OSV_SCANNER_PINNED_VERSION,
  OsvScannerAdapter,
} from "../src/infrastructure/providers/osv-scanner-adapter";

const fixedTime = "2026-08-24T12:00:00.000Z";

const processResult = (overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 11,
  timedOut: false,
  aborted: false,
  outputLimitExceeded: false,
  ...overrides,
});

const versionResult = (version = OSV_SCANNER_PINNED_VERSION): BoundedProcessResult =>
  processResult({
    stdout: [
      `osv-scanner version: ${version}`,
      "osv-scalibr version: 0.4.0",
      "commit: fixture",
      "built at: fixture",
    ].join("\n"),
  });

type RunnerStep = BoundedProcessResult | Error;

const runnerHarness = (...initialSteps: RunnerStep[]) => {
  const steps = [...initialSteps];
  const requests: BoundedProcessRequest[] = [];
  const runner: BoundedProcessRunner = {
    async run(request) {
      requests.push({ ...request, args: [...request.args] });
      const step = steps.shift();
      if (step === undefined) throw new Error("unexpected process invocation");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { requests, runner, remaining: () => steps.length };
};

const scannerJson = (
  sourcePath: string,
  options: {
    vulnerabilities?: Array<Record<string, unknown>>;
    groups?: Array<Record<string, unknown>>;
    package?: Record<string, unknown>;
    experimentalFindings?: unknown;
  } = {},
): string =>
  JSON.stringify({
    results: [
      {
        source: { path: sourcePath, type: "lockfile" },
        packages: [
          {
            package: {
              name: "fixture-package",
              version: "1.2.3",
              ecosystem: "npm",
              ...options.package,
            },
            ...(options.vulnerabilities !== undefined
              ? { vulnerabilities: options.vulnerabilities }
              : {}),
            ...(options.groups !== undefined ? { groups: options.groups } : {}),
          },
        ],
      },
    ],
    ...(options.experimentalFindings !== undefined
      ? { experimental_generic_findings: options.experimentalFindings }
      : {}),
  });

describe("OSV-Scanner v2.5.1 process adapter", () => {
  let temporaryRoot: string;
  let sandboxPath: string;
  let lockfilePath: string;
  let trustedConfigPath: string;
  let commandPath: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "maf-osv-adapter-"));
    sandboxPath = path.join(temporaryRoot, "candidate");
    lockfilePath = path.join(sandboxPath, "package-lock.json");
    trustedConfigPath = path.join(temporaryRoot, "trusted", "osv-scanner.toml");
    commandPath = path.join(
      temporaryRoot,
      "tools",
      process.platform === "win32" ? "osv-scanner.exe" : "osv-scanner",
    );
    await mkdir(sandboxPath, { recursive: true });
    await mkdir(path.dirname(trustedConfigPath), { recursive: true });
    await writeFile(lockfilePath, '{"lockfileVersion":3,"packages":{}}\n', "utf8");
    await writeFile(trustedConfigPath, "# MAF-owned and intentionally empty\n", "utf8");
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const adapterFor = (runner: BoundedProcessRunner): OsvScannerAdapter =>
    new OsvScannerAdapter({
      command: commandPath,
      trustedConfigPath,
      timeoutMs: 45_000,
      probeTimeoutMs: 2_000,
      runner,
      now: () => new Date(fixedTime),
    });

  const input = (
    changedFiles: string[] = ["package-lock.json"],
    signal?: AbortSignal,
  ): CapabilityInput => ({
    capabilityId: "SECURITY.DEPENDENCY_VULNERABILITY_SCAN",
    sandbox: {
      id: "sandbox-1",
      path: sandboxPath,
      repositoryPath: sandboxPath,
      baseRevision: "base-revision-1",
      revision: "main",
    },
    diff: { patch: "fixture patch", changedFiles },
    candidateId: "candidate-1",
    diffDigest: "sha256:candidate-1",
    ...(signal !== undefined ? { signal } : {}),
  });

  it("probes and caches the exact pinned version", async () => {
    const harness = runnerHarness(versionResult());
    const adapter = adapterFor(harness.runner);

    await expect(adapter.probe()).resolves.toEqual({
      available: true,
      version: OSV_SCANNER_PINNED_VERSION,
      detail: `OSV-Scanner ${OSV_SCANNER_PINNED_VERSION} is available.`,
    });
    await expect(adapter.probe()).resolves.toMatchObject({ available: true });

    expect(harness.requests).toEqual([
      {
        command: path.resolve(commandPath),
        args: ["--version"],
        cwd: path.dirname(path.resolve(commandPath)),
        timeoutMs: 2_000,
      },
    ]);
    expect(harness.remaining()).toBe(0);
  });

  it("keeps unsupported or malformed probe versions unavailable", async () => {
    const wrongVersion = runnerHarness(versionResult("2.5.0"));
    await expect(adapterFor(wrongVersion.runner).probe()).resolves.toEqual({
      available: false,
      version: "2.5.0",
      detail: `OSV-Scanner must be exactly version ${OSV_SCANNER_PINNED_VERSION}.`,
    });

    const malformed = runnerHarness(processResult({ stdout: "osv-scanner 2.5.1" }));
    await expect(adapterFor(malformed.runner).probe()).resolves.toMatchObject({
      available: false,
      version: null,
    });

    const prefixed = runnerHarness(
      processResult({
        stdout: `untrusted prefix\nosv-scanner version: ${OSV_SCANNER_PINNED_VERSION}`,
      }),
    );
    await expect(adapterFor(prefixed.runner).probe()).resolves.toMatchObject({
      available: false,
      version: null,
    });

    const bounded = runnerHarness(processResult({ outputLimitExceeded: true }));
    await expect(adapterFor(bounded.runner).probe()).resolves.toMatchObject({
      available: false,
      version: null,
    });
  });

  it("runs only the explicit lockfile with candidate-safe flags and emits bound findings", async () => {
    const scanOutput = scannerJson(lockfilePath, {
      vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "CVE-2026-0001" }],
      groups: [
        {
          ids: ["GHSA-aaaa-bbbb-cccc", "CVE-2026-0001"],
          aliases: ["GHSA-aaaa-bbbb-cccc", "CVE-2026-0001"],
          max_severity: "9.4",
        },
      ],
    });
    const harness = runnerHarness(
      versionResult(),
      processResult({ exitCode: 1, stdout: scanOutput, durationMs: 37 }),
    );
    const controller = new AbortController();
    const result = await adapterFor(harness.runner).analyze(input(undefined, controller.signal));

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toEqual({
      command: path.resolve(commandPath),
      args: [
        "scan",
        "source",
        "--format=json",
        "--verbosity=error",
        "--all-packages",
        "--all-vulns",
        "--no-resolve",
        "--no-call-analysis=all",
        `--config=${path.resolve(trustedConfigPath)}`,
        `--lockfile=${path.resolve(lockfilePath)}`,
      ],
      cwd: path.resolve(sandboxPath),
      timeoutMs: 45_000,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      provenance: {
        capabilityId: "SECURITY.DEPENDENCY_VULNERABILITY_SCAN",
        providerName: "osv-scanner",
        providerVersion: OSV_SCANNER_PINNED_VERSION,
        invokedAt: fixedTime,
        durationMs: 37,
        candidateId: "candidate-1",
        diffDigest: "sha256:candidate-1",
        baseRevision: "base-revision-1",
      },
      execution: { outcome: "COMPLETED", exitCode: 1 },
      coverage: { UNMODELLED: "PARTIAL" },
      analyzedFiles: ["package-lock.json"],
    });
    expect(result.negativeCoverage).toEqual({
      TS_JS: "UNSUPPORTED",
      PYTHON: "UNSUPPORTED",
      SHELL: "UNSUPPORTED",
      GENERIC_SCRIPTING: "UNSUPPORTED",
      BOUNDED_COMPILED: "UNSUPPORTED",
      UNMODELLED: "UNSUPPORTED",
      CONFIG_WORKFLOW: "UNSUPPORTED",
    });
    expect(result.findings).toEqual([
      {
        target: "SECURITY.DEPENDENCY_VULNERABILITY",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: "package-lock.json",
        ruleId: "CVE-2026-0001",
        message: "npm:fixture-package@1.2.3 matches known advisory CVE-2026-0001",
        severity: "CRITICAL",
      },
    ]);
  });

  it("retains clean output only as positive-partial, negative-unsupported evidence", async () => {
    const harness = runnerHarness(
      versionResult(),
      processResult({ exitCode: 0, stdout: scannerJson(lockfilePath), durationMs: 19 }),
    );

    const result = await adapterFor(harness.runner).analyze(input());

    expect(result.execution).toEqual({ outcome: "COMPLETED", exitCode: 0 });
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual({ UNMODELLED: "PARTIAL" });
    expect(result.negativeCoverage.UNMODELLED).toBe("UNSUPPORTED");
    expect(result.analyzedFiles).toEqual(["package-lock.json"]);
  });

  it("does not invoke a process for unsupported, mismatched, or unsafe input", async () => {
    const unsupportedHarness = runnerHarness();
    const unsupported = await adapterFor(unsupportedHarness.runner).analyze(
      input(["src/index.ts"]),
    );
    expect(unsupported.execution).toMatchObject({ outcome: "UNSUPPORTED" });
    expect(unsupportedHarness.requests).toEqual([]);

    const unsafeHarness = runnerHarness();
    const unsafe = await adapterFor(unsafeHarness.runner).analyze(input(["../package-lock.json"]));
    expect(unsafe.execution).toMatchObject({ outcome: "REFUSED" });
    expect(unsafeHarness.requests).toEqual([]);

    const mismatchHarness = runnerHarness();
    const mismatch = await adapterFor(mismatchHarness.runner).analyze({
      ...input(),
      capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
    });
    expect(mismatch.execution).toMatchObject({ outcome: "REFUSED" });
    expect(mismatchHarness.requests).toEqual([]);
  });

  it("requires the trusted override to be outside the sandbox and comment-only", async () => {
    await writeFile(trustedConfigPath, '[[IgnoredVulns]]\nid = "GHSA-hidden"\n', "utf8");
    const directiveHarness = runnerHarness();
    const directiveResult = await adapterFor(directiveHarness.runner).analyze(input());
    expect(directiveResult.execution).toMatchObject({ outcome: "REFUSED" });
    expect(directiveHarness.requests).toEqual([]);

    const candidateConfig = path.join(sandboxPath, "osv-scanner.toml");
    await writeFile(candidateConfig, '[[IgnoredVulns]]\nid = "GHSA-hidden"\n', "utf8");
    const insideHarness = runnerHarness();
    const adapter = new OsvScannerAdapter({
      command: commandPath,
      trustedConfigPath: candidateConfig,
      timeoutMs: 45_000,
      runner: insideHarness.runner,
    });
    const insideResult = await adapter.analyze(input());
    expect(insideResult.execution).toMatchObject({ outcome: "REFUSED" });
    expect(insideHarness.requests).toEqual([]);
  });

  it("maps structural process outcomes without interpreting their text", async () => {
    const cases: Array<{
      label: string;
      process: BoundedProcessResult | Error;
      expected: string;
    }> = [
      {
        label: "timeout",
        process: processResult({ timedOut: true, exitCode: null }),
        expected: "TIMED_OUT",
      },
      {
        label: "cancellation",
        process: processResult({ aborted: true, exitCode: null }),
        expected: "REFUSED",
      },
      {
        label: "output bound",
        process: processResult({ outputLimitExceeded: true, exitCode: null }),
        expected: "MALFORMED_OUTPUT",
      },
      {
        label: "spawn error",
        process: processResult({ exitCode: null, spawnError: "ENOENT" }),
        expected: "PROCESS_ERROR",
      },
      {
        label: "runner throw",
        process: new Error("runner failed"),
        expected: "PROCESS_ERROR",
      },
      {
        label: "no packages",
        process: processResult({ exitCode: 128 }),
        expected: "UNSUPPORTED",
      },
      {
        label: "API failure",
        process: processResult({ exitCode: 129 }),
        expected: "PROCESS_ERROR",
      },
      {
        label: "invalid config",
        process: processResult({ exitCode: 130 }),
        expected: "PROCESS_ERROR",
      },
    ];

    for (const testCase of cases) {
      const harness = runnerHarness(versionResult(), testCase.process);
      const result = await adapterFor(harness.runner).analyze(input());
      expect(result.execution.outcome, testCase.label).toBe(testCase.expected);
      expect(result.findings, testCase.label).toEqual([]);
      expect(result.analyzedFiles, testCase.label).toEqual([]);
    }
  });

  it("rejects malformed, contradictory, partial, or out-of-scope JSON", async () => {
    const outsidePath = path.join(sandboxPath, "other", "package-lock.json");
    const missingGroups = scannerJson(lockfilePath, {
      vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc" }],
    });
    const cases: Array<{
      label: string;
      exitCode: 0 | 1;
      stdout: string;
      stderr?: string;
    }> = [
      { label: "invalid JSON", exitCode: 0, stdout: "{" },
      { label: "exit 1 without findings", exitCode: 1, stdout: scannerJson(lockfilePath) },
      {
        label: "exit 0 with findings",
        exitCode: 0,
        stdout: scannerJson(lockfilePath, {
          vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc" }],
          groups: [
            {
              ids: ["GHSA-aaaa-bbbb-cccc"],
              aliases: ["GHSA-aaaa-bbbb-cccc"],
              max_severity: "7.2",
            },
          ],
        }),
      },
      { label: "missing groups", exitCode: 1, stdout: missingGroups },
      { label: "unrequested source", exitCode: 0, stdout: scannerJson(outsidePath) },
      {
        label: "successful code with error diagnostics",
        exitCode: 0,
        stdout: scannerJson(lockfilePath),
        stderr: "extractor reported a partial failure",
      },
      {
        label: "experimental findings",
        exitCode: 1,
        stdout: scannerJson(lockfilePath, { experimentalFindings: [{ plugin: "candidate" }] }),
      },
    ];

    for (const testCase of cases) {
      const harness = runnerHarness(
        versionResult(),
        processResult({
          exitCode: testCase.exitCode,
          stdout: testCase.stdout,
          stderr: testCase.stderr ?? "",
        }),
      );
      const result = await adapterFor(harness.runner).analyze(input());
      expect(result.execution.outcome, testCase.label).toBe("MALFORMED_OUTPUT");
      expect(result.findings, testCase.label).toEqual([]);
      expect(result.analyzedFiles, testCase.label).toEqual([]);
    }
  });

  it("treats an absent explicit changed lockfile as unsupported without probing", async () => {
    await rm(lockfilePath);
    const harness = runnerHarness();

    const result = await adapterFor(harness.runner).analyze(input());

    expect(result.execution).toMatchObject({ outcome: "UNSUPPORTED" });
    expect(harness.requests).toEqual([]);
  });
});
