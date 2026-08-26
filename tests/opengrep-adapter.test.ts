import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityInput } from "../src/domain/capability/provider";
import {
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type BoundedProcessRunner,
  computeOpenGrepRulesetDigest,
  OPEN_GREP_PINNED_VERSION,
  OpenGrepAdapter,
  type OpenGrepAdapterConfig,
  type OpenGrepRuleManifest,
} from "../src/infrastructure/providers/opengrep-adapter";

const command = resolve(".tools", "opengrep.exe");
const invokedAt = "2026-08-24T01:02:03.000Z";
const ruleBytes = Buffer.from(
  "rules:\n  - id: maf.sensitive-input-flow\n    languages: [typescript]\n    message: audited\n    severity: ERROR\n    pattern: $X\n",
  "utf8",
);

let temporaryRoot: string;
let rulesPath: string;
let sandboxPath: string;
let rulesetDigest: string;

const rulesetBounds = {
  maxFileBytes: 1_048_576,
  maxRuleCount: 128,
  maxRuleIdBytes: 256,
  maxMessageBytes: 2_048,
};

const manifest: OpenGrepRuleManifest = {
  rules: [
    {
      ruleId: "maf.sensitive-input-flow",
      target: "SECURITY.SENSITIVE_INPUT_FLOW",
      languageClasses: ["TS_JS", "PYTHON"],
      severity: "HIGH",
      message: "Sensitive input reaches an exposure sink.",
    },
    {
      ruleId: "maf.environment-secret-exposure",
      target: "SECURITY.ENV_SECRET_EXPOSURE",
      languageClasses: ["TS_JS", "PYTHON"],
      severity: "MEDIUM",
      message: "An environment secret reaches an output sink.",
    },
  ],
};

const fixtureTargets = [
  "src/a.py",
  "src/z.ts",
  "src/one.ts",
  "src/two.ts",
  "src/target.ts",
  "workflow.yml",
];

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "maf-opengrep-adapter-"));
  rulesPath = join(temporaryRoot, "maf-owned-rules.yml");
  sandboxPath = join(temporaryRoot, "candidate");
  await mkdir(join(sandboxPath, "src"), { recursive: true });
  await writeFile(rulesPath, ruleBytes);
  await Promise.all(
    fixtureTargets.map(async (target) => {
      const targetPath = join(sandboxPath, ...target.split("/"));
      await writeFile(targetPath, `fixture for ${target}\n`);
    }),
  );
  rulesetDigest = computeOpenGrepRulesetDigest(ruleBytes, manifest);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

const processResult = (overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 17,
  timedOut: false,
  aborted: false,
  outputLimitExceeded: false,
  ...overrides,
});

const queuedRunner = (...items: Array<BoundedProcessResult | Error>) => {
  const run = vi.fn(async (_request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    const item = items.shift();
    if (item === undefined) throw new Error("unexpected process invocation");
    if (item instanceof Error) throw item;
    return item;
  });
  return { runner: { run } satisfies BoundedProcessRunner, run };
};

const adapter = (
  runner: BoundedProcessRunner,
  overrides: Partial<OpenGrepAdapterConfig> = {},
): OpenGrepAdapter =>
  new OpenGrepAdapter({
    command,
    rulesPath,
    rulesetDigest,
    manifest,
    rulesetBounds,
    targetBounds: {
      maxCount: 32,
      maxArgumentBytes: 16_384,
      maxFileBytes: 1_048_576,
    },
    timeoutMs: 30_000,
    probeTimeoutMs: 2_000,
    runner,
    now: () => new Date(invokedAt),
    ...overrides,
  });

const capabilityInput = (changedFiles: string[]): CapabilityInput => ({
  capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
  sandbox: {
    id: "sandbox-1",
    path: sandboxPath,
    repositoryPath: resolve("tests", "fixtures", "repository"),
    baseRevision: "base-revision-1",
    revision: "main",
  },
  diff: { patch: "fixture patch", changedFiles },
  candidateId: "candidate-1",
  diffDigest: "sha256:candidate-1",
});

const jsonOutput = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: OPEN_GREP_PINNED_VERSION,
    errors: [],
    paths: { scanned: [] },
    results: [],
    skipped_rules: [],
    interfile_languages_used: [],
    ...overrides,
  });

const finding = (
  ruleId: string,
  path: string,
  severity: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  check_id: ruleId,
  path,
  start: { line: 7, col: 3, offset: 11 },
  end: { line: 7, col: 20, offset: 28 },
  extra: {
    message: "candidate-expanded output is deliberately not trusted",
    severity,
    is_ignored: false,
  },
  ...overrides,
});

describe("OpenGrepAdapter", () => {
  it("requires an absolute local MAF-owned rules path, digest, and exact target manifest", () => {
    const { runner } = queuedRunner();

    expect(() => adapter(runner, { rulesPath: "auto" })).toThrow(
      "rulesPath must be an absolute local filesystem path",
    );
    expect(() => adapter(runner, { rulesPath: "https://example.invalid/rules.yml" })).toThrow(
      "rulesPath must be an absolute local filesystem path",
    );
    expect(() => adapter(runner, { rulesetDigest: "sha256:not-a-digest" })).toThrow(
      "rulesetDigest must be a sha256 digest",
    );
    expect(() =>
      adapter(runner, {
        manifest: {
          rules: [
            {
              ...manifest.rules[0],
              target: "SECURITY.AUTHORIZATION_BEHAVIOR",
            },
          ],
        } as unknown as OpenGrepRuleManifest,
      }),
    ).toThrow("only to established semantic-flow targets");
  });

  it("canonicalizes manifest ordering while keeping exact rule bytes in the digest", () => {
    const sensitiveRule = manifest.rules[0];
    const environmentRule = manifest.rules[1];
    if (sensitiveRule === undefined || environmentRule === undefined) {
      throw new Error("test manifest fixture is incomplete");
    }
    const reorderedManifest: OpenGrepRuleManifest = {
      rules: [
        {
          ...environmentRule,
          languageClasses: ["PYTHON", "TS_JS"],
        },
        {
          ...sensitiveRule,
          languageClasses: ["PYTHON", "TS_JS"],
        },
      ],
    };

    expect(computeOpenGrepRulesetDigest(ruleBytes, reorderedManifest)).toBe(rulesetDigest);
    expect(
      computeOpenGrepRulesetDigest(
        Buffer.concat([ruleBytes, Buffer.from("# changed\n")]),
        manifest,
      ),
    ).not.toBe(rulesetDigest);
  });

  it("bounds manifest rule count and trusted rule ID/message bytes", () => {
    const { runner } = queuedRunner();
    const sensitiveRule = manifest.rules[0];
    if (sensitiveRule === undefined) throw new Error("test manifest fixture is incomplete");

    expect(() =>
      adapter(runner, {
        rulesetBounds: { ...rulesetBounds, maxRuleCount: 1 },
      }),
    ).toThrow("rule-count bound");
    expect(() =>
      adapter(runner, {
        manifest: { rules: [{ ...sensitiveRule, ruleId: "éé" }] },
        rulesetBounds: { ...rulesetBounds, maxRuleIdBytes: 3 },
      }),
    ).toThrow("rule ID exceeded the configured byte bound");
    expect(() =>
      adapter(runner, {
        manifest: { rules: [{ ...sensitiveRule, message: "🔐" }] },
        rulesetBounds: { ...rulesetBounds, maxMessageBytes: 3 },
      }),
    ).toThrow("message exceeded the configured byte bound");
  });

  it("refuses an oversized rule file before starting any process", async () => {
    const { runner, run } = queuedRunner();

    const result = await adapter(runner, {
      rulesetBounds: { ...rulesetBounds, maxFileBytes: ruleBytes.byteLength - 1 },
    }).analyze(capabilityInput(["src/target.ts"]));

    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      findings: [],
      analyzedFiles: [],
      provenance: { rulesetDigest },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an initial ruleset digest mismatch before starting any process", async () => {
    const wrongDigest = `sha256:${"0".repeat(64)}`;
    const { runner, run } = queuedRunner();

    const result = await adapter(runner, { rulesetDigest: wrongDigest }).analyze(
      capabilityInput(["src/target.ts"]),
    );

    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      findings: [],
      analyzedFiles: [],
      provenance: { rulesetDigest: wrongDigest },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a rules directory or symlink before starting any process", async () => {
    const rulesDirectory = join(temporaryRoot, "rules-directory");
    await mkdir(rulesDirectory);
    const directoryRunner = queuedRunner();
    const directoryResult = await adapter(directoryRunner.runner, {
      rulesPath: rulesDirectory,
    }).analyze(capabilityInput(["src/target.ts"]));
    expect(directoryResult.execution.outcome).toBe("REFUSED");
    expect(directoryRunner.run).not.toHaveBeenCalled();

    const rulesLink = join(temporaryRoot, "rules-link");
    await symlink(rulesDirectory, rulesLink, "junction");
    const symlinkRunner = queuedRunner();
    const symlinkResult = await adapter(symlinkRunner.runner, {
      rulesPath: rulesLink,
    }).analyze(capabilityInput(["src/target.ts"]));
    expect(symlinkResult.execution.outcome).toBe("REFUSED");
    expect(symlinkRunner.run).not.toHaveBeenCalled();
  });

  it("discards scan findings when the rules change during execution", async () => {
    const scanJson = jsonOutput({
      paths: { scanned: ["src/target.ts"] },
      results: [finding("maf.sensitive-input-flow", "src/target.ts", "ERROR")],
    });
    const run = vi.fn(async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
      if (request.args[0] === "--version") {
        return processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n`, durationMs: 2 });
      }
      await writeFile(rulesPath, Buffer.concat([ruleBytes, Buffer.from("# changed\n")]));
      return processResult({ stdout: scanJson, durationMs: 41 });
    });

    const result = await adapter({ run }).analyze(capabilityInput(["src/target.ts"]));

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      provenance: { rulesetDigest, durationMs: 41 },
      findings: [],
      analyzedFiles: [],
    });
  });

  it("discards scan findings when target metadata changes during execution", async () => {
    const target = join(sandboxPath, "src", "target.ts");
    const scanJson = jsonOutput({
      paths: { scanned: ["src/target.ts"] },
      results: [finding("maf.sensitive-input-flow", "src/target.ts", "ERROR")],
    });
    const run = vi.fn(async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
      if (request.args[0] === "--version") {
        return processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` });
      }
      await writeFile(target, "target changed while OpenGrep was running\n");
      return processResult({ stdout: scanJson, durationMs: 37 });
    });

    const result = await adapter({ run }).analyze(capabilityInput(["src/target.ts"]));

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      provenance: { durationMs: 37 },
      findings: [],
      analyzedFiles: [],
    });
  });

  it("discards scan findings when a target identity is replaced during execution", async () => {
    const target = join(sandboxPath, "src", "target.ts");
    const displacedTarget = join(temporaryRoot, "displaced-target.ts");
    const scanJson = jsonOutput({
      paths: { scanned: ["src/target.ts"] },
      results: [finding("maf.sensitive-input-flow", "src/target.ts", "ERROR")],
    });
    const run = vi.fn(async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
      if (request.args[0] === "--version") {
        return processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` });
      }
      await rename(target, displacedTarget);
      await writeFile(target, "fixture for src/target.ts\n");
      return processResult({ stdout: scanJson, durationMs: 38 });
    });

    const result = await adapter({ run }).analyze(capabilityInput(["src/target.ts"]));

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      provenance: { durationMs: 38 },
      findings: [],
      analyzedFiles: [],
    });
  });

  it("discards scan findings when a target canonical path changes during execution", async () => {
    const sourceA = join(sandboxPath, "source-a");
    const sourceB = join(sandboxPath, "source-b");
    const targetParent = join(sandboxPath, "linked-source");
    await mkdir(sourceA);
    await mkdir(sourceB);
    await writeFile(join(sourceA, "target.ts"), "source A\n");
    await writeFile(join(sourceB, "target.ts"), "source B\n");
    await symlink(sourceA, targetParent, "junction");
    const scanJson = jsonOutput({
      paths: { scanned: ["linked-source/target.ts"] },
      results: [finding("maf.sensitive-input-flow", "linked-source/target.ts", "ERROR")],
    });
    const run = vi.fn(async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
      if (request.args[0] === "--version") {
        return processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` });
      }
      await rename(targetParent, join(sandboxPath, "original-linked-source"));
      await symlink(sourceB, targetParent, "junction");
      return processResult({ stdout: scanJson, durationMs: 39 });
    });

    const result = await adapter({ run }).analyze(capabilityInput(["linked-source/target.ts"]));

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      execution: { outcome: "REFUSED" },
      provenance: { durationMs: 39 },
      findings: [],
      analyzedFiles: [],
    });
  });

  it("probes and caches exactly stable v1.27.1 with version checking disabled", async () => {
    const { runner, run } = queuedRunner(
      processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n`, durationMs: 3 }),
    );
    const provider = adapter(runner);

    await expect(provider.probe()).resolves.toEqual({
      available: true,
      version: OPEN_GREP_PINNED_VERSION,
      detail: `OpenGrep ${OPEN_GREP_PINNED_VERSION} is available.`,
    });
    await expect(provider.probe()).resolves.toMatchObject({ available: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      command,
      args: ["--version", "--disable-version-check"],
      cwd: dirname(command),
      timeoutMs: 2_000,
    });

    const mismatch = queuedRunner(processResult({ stdout: "1.28.0-interfile.alpha.2\n" }));
    await expect(adapter(mismatch.runner).probe()).resolves.toEqual({
      available: false,
      version: "1.28.0-interfile.alpha.2",
      detail: `OpenGrep must be exactly version ${OPEN_GREP_PINNED_VERSION}.`,
    });
  });

  it("uses only safe local scan flags and normalizes manifested positive findings", async () => {
    const scanJson = jsonOutput({
      paths: { scanned: ["src/a.py", "src/z.ts"] },
      results: [
        finding("maf.sensitive-input-flow", "src/z.ts", "ERROR"),
        finding("maf.environment-secret-exposure", "src/a.py", "WARNING"),
        finding("maf.sensitive-input-flow", "src/z.ts", "ERROR", {
          start: { line: 9, col: 1, offset: 40 },
          extra: {
            message: "suppressed candidate-expanded output",
            severity: "ERROR",
            is_ignored: true,
          },
        }),
      ],
    });
    const { runner, run } = queuedRunner(
      processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n`, durationMs: 2 }),
      processResult({ stdout: scanJson, durationMs: 41 }),
    );
    const provider = adapter(runner);
    const signal = new AbortController().signal;

    const result = await provider.analyze({
      ...capabilityInput(["src/z.ts", "src/a.py", "src/z.ts"]),
      signal,
    });

    expect(run).toHaveBeenCalledTimes(2);
    const scanRequest = run.mock.calls[1]?.[0];
    expect(scanRequest).toEqual({
      command,
      args: [
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
        rulesPath,
        "--",
        "src/a.py",
        "src/z.ts",
      ],
      cwd: sandboxPath,
      timeoutMs: 30_000,
      signal,
    });
    expect(scanRequest?.args).not.toContain("auto");
    expect(scanRequest?.args).not.toContain("--experimental");
    expect(scanRequest?.args).not.toContain("--taint-interfile");
    expect(scanRequest?.args).not.toContain("--pro");
    expect(scanRequest?.args).not.toContain("--autofix");

    expect(result).toMatchObject({
      execution: { outcome: "COMPLETED", exitCode: 0 },
      provenance: {
        capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
        providerName: "opengrep",
        providerVersion: OPEN_GREP_PINNED_VERSION,
        rulesetDigest,
        invokedAt,
        durationMs: 41,
        candidateId: "candidate-1",
        diffDigest: "sha256:candidate-1",
        baseRevision: "base-revision-1",
      },
      analyzedFiles: ["src/a.py", "src/z.ts"],
      coverage: { TS_JS: "FULL", PYTHON: "FULL" },
    });
    expect(result.findings).toEqual([
      {
        target: "SECURITY.SENSITIVE_INPUT_FLOW",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: "src/z.ts",
        line: 7,
        ruleId: "maf.sensitive-input-flow",
        message: "Sensitive input reaches an exposure sink.",
        severity: "HIGH",
      },
      {
        target: "SECURITY.ENV_SECRET_EXPOSURE",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: "src/a.py",
        line: 7,
        ruleId: "maf.environment-secret-exposure",
        message: "An environment secret reaches an output sink.",
        severity: "MEDIUM",
      },
    ]);
    expect(Object.values(result.negativeCoverage)).toEqual([
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
      "UNSUPPORTED",
    ]);
  });

  it("reconciles paths exactly and reports partial positive coverage without absence authority", async () => {
    const { runner } = queuedRunner(
      processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` }),
      processResult({
        stdout: jsonOutput({ paths: { scanned: ["src/one.ts"] } }),
      }),
    );

    const result = await adapter(runner).analyze(
      capabilityInput(["src/one.ts", "src/two.ts", "workflow.yml"]),
    );

    expect(result).toMatchObject({
      execution: { outcome: "COMPLETED" },
      findings: [],
      analyzedFiles: ["src/one.ts"],
      coverage: { TS_JS: "PARTIAL", CONFIG_WORKFLOW: "UNSUPPORTED" },
      negativeCoverage: {
        TS_JS: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    });
  });

  it("rejects scanned or finding paths outside the exact changed-file scope", async () => {
    const extraScan = queuedRunner(
      processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` }),
      processResult({
        stdout: jsonOutput({ paths: { scanned: ["src/target.ts", "src/not-changed.ts"] } }),
      }),
    );
    const extraScanResult = await adapter(extraScan.runner).analyze(
      capabilityInput(["src/target.ts"]),
    );
    expect(extraScanResult).toMatchObject({
      execution: { outcome: "MALFORMED_OUTPUT" },
      findings: [],
      analyzedFiles: [],
    });

    const unscannedFinding = queuedRunner(
      processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` }),
      processResult({
        stdout: jsonOutput({
          paths: { scanned: [] },
          results: [finding("maf.sensitive-input-flow", "src/target.ts", "ERROR")],
        }),
      }),
    );
    const unscannedResult = await adapter(unscannedFinding.runner).analyze(
      capabilityInput(["src/target.ts"]),
    );
    expect(unscannedResult.execution.outcome).toBe("MALFORMED_OUTPUT");
    expect(unscannedResult.findings).toEqual([]);
  });

  it("rejects unmanifested rules, severity drift, and unexpected interfile claims", async () => {
    const cases = [
      jsonOutput({
        paths: { scanned: ["src/target.ts"] },
        results: [finding("unknown.rule", "src/target.ts", "ERROR")],
      }),
      jsonOutput({
        paths: { scanned: ["src/target.ts"] },
        results: [finding("maf.sensitive-input-flow", "src/target.ts", "WARNING")],
      }),
      jsonOutput({
        paths: { scanned: ["src/target.ts"] },
        interfile_languages_used: ["typescript"],
      }),
    ];

    for (const stdout of cases) {
      const { runner } = queuedRunner(
        processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` }),
        processResult({ stdout }),
      );
      const result = await adapter(runner).analyze(capabilityInput(["src/target.ts"]));
      expect(result.execution.outcome).toBe("MALFORMED_OUTPUT");
      expect(result.findings).toEqual([]);
    }
  });

  it("keeps timeout, output overflow, nonzero exit, JSON errors, and malformed JSON non-results", async () => {
    const cases: Array<{
      scan: BoundedProcessResult;
      expected: string;
    }> = [
      {
        scan: processResult({ timedOut: true, exitCode: null, durationMs: 30_000 }),
        expected: "TIMED_OUT",
      },
      {
        scan: processResult({ outputLimitExceeded: true, exitCode: null }),
        expected: "MALFORMED_OUTPUT",
      },
      {
        scan: processResult({ exitCode: 14, stderr: "candidate-controlled diagnostic" }),
        expected: "PROCESS_ERROR",
      },
      {
        scan: processResult({
          stdout: jsonOutput({ errors: [{ code: 3, level: "error" }] }),
        }),
        expected: "PROCESS_ERROR",
      },
      {
        scan: processResult({ stdout: "{not-json" }),
        expected: "MALFORMED_OUTPUT",
      },
    ];

    for (const testCase of cases) {
      const { runner } = queuedRunner(
        processResult({ stdout: `${OPEN_GREP_PINNED_VERSION}\n` }),
        testCase.scan,
      );
      const result = await adapter(runner).analyze(capabilityInput(["src/target.ts"]));
      expect(result.execution.outcome).toBe(testCase.expected);
      expect(result.findings).toEqual([]);
      expect(result.analyzedFiles).toEqual([]);
      expect(Object.values(result.negativeCoverage).every((value) => value === "UNSUPPORTED")).toBe(
        true,
      );
    }
  });

  it("refuses capability spoofing and unsafe changed-file paths without starting a process", async () => {
    const mismatchRunner = queuedRunner();
    const mismatch = await adapter(mismatchRunner.runner).analyze({
      ...capabilityInput(["src/target.ts"]),
      capabilityId: "SECURITY.CREDENTIAL_LITERAL_SCAN",
    });
    expect(mismatch.execution.outcome).toBe("REFUSED");
    expect(mismatchRunner.run).not.toHaveBeenCalled();

    const traversalRunner = queuedRunner();
    const traversal = await adapter(traversalRunner.runner).analyze(
      capabilityInput(["../outside.ts"]),
    );
    expect(traversal.execution.outcome).toBe("REFUSED");
    expect(traversalRunner.run).not.toHaveBeenCalled();

    const emptyRunner = queuedRunner();
    const empty = await adapter(emptyRunner.runner).analyze(capabilityInput([]));
    expect(empty.execution.outcome).toBe("UNSUPPORTED");
    expect(emptyRunner.run).not.toHaveBeenCalled();
  });

  it("refuses missing, symlinked, escaping, and over-bound changed-file targets", async () => {
    const missingRunner = queuedRunner();
    const missing = await adapter(missingRunner.runner).analyze(
      capabilityInput(["src/deleted.ts"]),
    );
    expect(missing.execution.outcome).toBe("REFUSED");
    expect(missingRunner.run).not.toHaveBeenCalled();

    const outsideDirectory = join(temporaryRoot, "outside-directory");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "escaped.ts"), "outside through parent link\n");
    const targetLink = join(sandboxPath, "escaped");
    await symlink(outsideDirectory, targetLink, "junction");
    const symlinkRunner = queuedRunner();
    const symlinkResult = await adapter(symlinkRunner.runner).analyze(capabilityInput(["escaped"]));
    expect(symlinkResult.execution.outcome).toBe("REFUSED");
    expect(symlinkRunner.run).not.toHaveBeenCalled();

    const escapeRunner = queuedRunner();
    const escapeResult = await adapter(escapeRunner.runner).analyze(
      capabilityInput(["escaped/escaped.ts"]),
    );
    expect(escapeResult.execution.outcome).toBe("REFUSED");
    expect(escapeRunner.run).not.toHaveBeenCalled();

    const countRunner = queuedRunner();
    const countResult = await adapter(countRunner.runner, {
      targetBounds: { maxCount: 1, maxArgumentBytes: 16_384, maxFileBytes: 1_048_576 },
    }).analyze(capabilityInput(["src/one.ts", "src/two.ts"]));
    expect(countResult.execution.outcome).toBe("REFUSED");
    expect(countRunner.run).not.toHaveBeenCalled();

    const argumentRunner = queuedRunner();
    const argumentResult = await adapter(argumentRunner.runner, {
      targetBounds: { maxCount: 32, maxArgumentBytes: 1, maxFileBytes: 1_048_576 },
    }).analyze(capabilityInput(["src/one.ts"]));
    expect(argumentResult.execution.outcome).toBe("REFUSED");
    expect(argumentRunner.run).not.toHaveBeenCalled();

    const fileSizeRunner = queuedRunner();
    const fileSizeResult = await adapter(fileSizeRunner.runner, {
      targetBounds: { maxCount: 32, maxArgumentBytes: 16_384, maxFileBytes: 1 },
    }).analyze(capabilityInput(["src/one.ts"]));
    expect(fileSizeResult.execution.outcome).toBe("REFUSED");
    expect(fileSizeRunner.run).not.toHaveBeenCalled();
  });

  it("maps failed or mismatched probes to unavailable and never launches a scan", async () => {
    const mismatch = queuedRunner(processResult({ stdout: "1.26.0\n" }));
    const result = await adapter(mismatch.runner).analyze(capabilityInput(["src/target.ts"]));
    expect(result).toMatchObject({
      execution: { outcome: "UNAVAILABLE" },
      findings: [],
      analyzedFiles: [],
      provenance: { providerVersion: OPEN_GREP_PINNED_VERSION, rulesetDigest },
    });
    expect(mismatch.run).toHaveBeenCalledTimes(1);

    const failed = queuedRunner(new Error("spawn failed"));
    await expect(adapter(failed.runner).probe()).resolves.toMatchObject({
      available: false,
      version: null,
    });
  });
});
