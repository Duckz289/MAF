/**
 * Verification failure attribution (post-pilot hardening, Finding A). A failing verification
 * command is NOT automatically a failing candidate: the pilot's correct candidate was "repaired"
 * by a model session because the verification environment lacked package metadata. This module
 * deterministically classifies a failed verification's evidence (exit code + output shape) into
 * a failure kind that says WHO or WHAT most plausibly needs to change — the candidate's code,
 * the verification environment, a dependency, shared infrastructure — or honestly UNKNOWN when
 * the evidence does not justify a specific attribution.
 *
 * Classification is conservative in BOTH directions:
 * - environment/dependency/infrastructure patterns require STRONG evidence that the verifier or
 *   its toolchain itself was unavailable (the command could not be spawned, the package manager
 *   could not resolve, the service could not be reached). Import/path failure shapes that a
 *   candidate's own code can cause (ModuleNotFoundError, "cannot find module", missing files,
 *   test collection failures) are deliberately AMBIGUOUS: they are classified UNKNOWN so the
 *   candidate remains repairable, because a broken candidate import and a broken verifier
 *   toolchain produce byte-identical output. Guessing "environment" here would repeat the
 *   pilot's failure in mirror image: starving a genuinely broken candidate of repair.
 * - anything unrecognized is UNKNOWN, never guessed into a specific bucket;
 * - a failed verification is NEVER turned into a pass by attribution. Trust stays fail-closed;
 *   attribution only decides which REMEDIATION is justified (retry vs repair vs stop).
 */

export type VerificationFailureKind =
  | "CANDIDATE_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "INFRASTRUCTURE_FAILURE"
  /**
   * The verification did not finish because a bounded-execution limit stopped it: the harness's
   * own timeout, a terminating signal, or an exhausted resource ceiling. This is a distinct kind
   * because it needs a distinct remediation. It is NOT candidate-bound (a slow machine and an
   * introduced deadlock produce the same shape), so it must not be asserted as a test failure; and
   * a cheap deterministic re-run is NOT useful (re-running a timeout costs another full timeout,
   * and an out-of-memory ceiling is reproducible), so it must not consume the environment retry.
   * Model repair stays available: a candidate CAN introduce a hang or a runaway allocation.
   */
  | "EXECUTION_LIMIT_FAILURE"
  | "UNKNOWN_FAILURE";

export interface VerificationFailureAttribution {
  kind: VerificationFailureKind;
  /** File/line-shaped or pattern-shaped reasons, always human-readable. */
  evidence: string[];
  /**
   * True only when the evidence plausibly binds the failure to the candidate's own code —
   * the only attribution that justifies spending model budget on candidate repair.
   */
  candidateBound: boolean;
  /**
   * Whether re-running the SAME trusted verifier unchanged has a real chance of a different
   * outcome. Separate from `candidateBound` because the two questions are independent, and
   * conflating them is what made a verifier timeout consume a full second timeout before repair:
   * "not the candidate's fault" does not imply "try again".
   *
   * True for cold-cache/dependency/service-availability shapes and for honestly unknown output.
   * False for candidate-bound failures (the code has to change) and for execution-limit failures
   * (the limit will be hit again). Absent on records produced before this field existed; callers
   * default it to `!candidateBound`, which is the previous behaviour.
   */
  environmentRetryUseful: boolean;
}

export interface VerificationFailureInput {
  command?: string | undefined;
  exitCode?: number | undefined;
  output: string;
  /** True when the verification was expected-file based (no command ran). */
  expectedFileVerification?: boolean;
  /**
   * Structured execution evidence from the verifier boundary (which shell ran, whether the
   * command's NAME resolved). When present it is authoritative over output-text patterns: the
   * boundary sees the shell's machine-readable error records, which generic prose matching cannot
   * reproduce reliably across shells (PowerShell's CommandNotFoundException exits 1 with prose no
   * generic pattern matches).
   */
  execution?: import("./types").VerifierExecutionEvidence | undefined;
}

interface FailurePattern {
  kind: VerificationFailureKind;
  evidence: string;
  pattern: RegExp;
}

// Order matters: specific, strong environment/dependency/infrastructure signatures are checked
// before test-failure shapes. Import/not-found shapes are NOT here by design — see the module
// comment: they are ambiguous between candidate code and toolchain, and land in UNKNOWN below.
const failurePatterns: FailurePattern[] = [
  {
    kind: "ENVIRONMENT_FAILURE",
    evidence: "verification command itself could not be found or spawned",
    // `commandnotfoundexception` is PowerShell's machine-readable error-record ID (it also appears
    // in FullyQualifiedErrorId) — an error TYPE, not prose — and the "name of a cmdlet" phrase is
    // that error record's own phrasing. Kept as fallback for records lacking structured evidence.
    pattern:
      /\bcommand not found\b|commandnotfoundexception|is not recognized as (?:an internal|a valid|the name of a cmdlet)|\bspawn\b[^\n]*\benoent\b|\benoent\b[^\n]*\bspawn\b|failed to spawn|executable(?: file)? not found(?: in)?(?: \$?path)?|exit status 127/iu,
  },
  {
    kind: "ENVIRONMENT_FAILURE",
    evidence: "verification interpreter/toolchain itself was not found",
    // Narrow: only the INTERPRETER being missing. "python: can't open file 'verify.py'" means
    // python ran and a script was absent — that is candidate-causable and stays ambiguous below.
    pattern:
      /\bpython(?:3)?\b[^\n]*\bnot found\b|\bnode\b[^\n]*\bnot found\b|no python interpreter|virtualenv (?:not found|could not be created)/iu,
  },
  {
    kind: "DEPENDENCY_FAILURE",
    evidence: "dependency resolution/version conflict",
    // No ENOENT/package.json shape here (hardening pass #3): a missing package.json is ambiguous —
    // the candidate may have failed to produce it — so it must fall through to UNKNOWN (ambiguous,
    // repair available), not starve a candidate-caused failure of repair.
    pattern:
      /dependency (?:resolution|conflict)|version ?conflict|peer dep(?:endency)? (?:error|conflict|mismatch)|unable to resolve dependenc|incompatible (?:operator|version)|module version mismatch|\beresolve\b[^\n]*unable to resolve/iu,
  },
  {
    kind: "INFRASTRUCTURE_FAILURE",
    evidence: "network/service infrastructure unavailable during verification",
    pattern:
      /econnrefused|econnreset|etimedout|eai_again|socket hang up|\bconnection refused\b|\b503 service unavailable\b|\b502 bad gateway\b|database is unavailable|could not connect/iu,
  },
  {
    kind: "EXECUTION_LIMIT_FAILURE",
    evidence:
      "the verification process exhausted a resource ceiling rather than reporting a result",
    // A narrow, unambiguous signature set: these strings are emitted by a RUNTIME that ran out of
    // memory, not by a test that failed. Deliberately not a catalog — structured
    // `execution.termination` evidence is the primary source for limit-shaped outcomes, and this
    // covers only the ceiling the harness itself cannot observe (the child's own allocator).
    pattern:
      /javascript heap out of memory|\bout of memory\b|cannot allocate memory|std::bad_alloc|\bOutOfMemoryError\b/iu,
  },
  {
    kind: "CANDIDATE_FAILURE",
    evidence: "test assertions failed against the candidate's code",
    // Narrowed (hardening pass #4): the previous form matched a bare `assert`, which appears in
    // stack frames and package names inside failures that have nothing to do with assertions.
    // Only an assertion FAILURE shape counts now.
    pattern: /\bassertionerror\b|\bassertion (?:failed|error)\b|\bassert failed\b|\bexpect\(/iu,
  },
  {
    kind: "CANDIDATE_FAILURE",
    evidence: "test runner reported failing tests",
    // Narrowed (hardening pass #4): the previous form contained a bare `\b1? ?failed\b`, which
    // matched the word "failed" ANYWHERE — "Allocation failed", "Compilation failed", "Login
    // failed" all became candidate-bound test failures and immediately authorised model repair.
    // It also matched `×`, an ordinary multiplication sign. What remains requires the word to sit
    // next to a test/spec/check noun, or to carry a runner's own count/summary shape.
    //
    // Narrowed again (hardening pass #5, finding H3): `\b\d+ failed\b` still matched prose —
    // "1 failed to start the server" became a candidate-owned test failure and spent model repair
    // on an infrastructure problem. A bare count is only a runner SUMMARY when the count is
    // terminal (end of line, or followed by a separator/another count), which is how every runner
    // actually prints it ("2 failed", "1 failed, 4 passed", "Tests: 3 failed | 7 passed"). A count
    // followed by an infinitive or any other prose continuation is a sentence, not a summary.
    pattern:
      /\bfailed\b.{0,40}\b(?:test|spec|check)s?\b|\b(?:test|spec)s?\b.{0,40}\bfailed\b|\bfailing tests?\b|\b\d+ failed(?=\s*(?:$|[,;|)\]]|\s+\d+\s+\w))|\bfailed:? \d+\b|^\s*FAIL\s+\S+|✗|✘|✕/mu,
  },
  {
    kind: "CANDIDATE_FAILURE",
    evidence: "expected verification artifact was not produced",
    pattern: /^Missing /mu,
  },
];

// Import/not-found/collection shapes a CANDIDATE can cause (broken import in new code, a test
// module that no longer parses, a file the candidate forgot to create). They can ALSO mean a
// broken verifier toolchain (the pilot's missing package metadata) — the output text is
// indistinguishable. They are attributed UNKNOWN with the ambiguity stated, so the run-service
// retry-then-recover ladder keeps repair available instead of guessing environment-only.
const ambiguousFailurePatterns: FailurePattern[] = [
  {
    kind: "UNKNOWN_FAILURE",
    evidence:
      "module import failed — ambiguous between candidate code (importing a missing/uncreated module) and verifier toolchain (package not installed); repair stays available",
    pattern:
      /\bmodulenotfounderror\b|no module named|cannot find module|err_module_not_found|\bcannot find package\b|\bdistribution not found\b|\bimporterror\b|\bimporterror\b[^\n]*cannot import/iu,
  },
  {
    kind: "UNKNOWN_FAILURE",
    evidence:
      "file not found — ambiguous between candidate code (missing artifact/path it should produce) and verification environment (missing toolchain file)",
    pattern:
      /\bno such file or directory\b|\bfilenotfounderror\b|\bfile or directory does not exist\b/iu,
  },
  {
    kind: "UNKNOWN_FAILURE",
    evidence:
      "test collection/import failed before any test executed — most often the candidate's own test/module code, but a broken verifier environment produces the same shape",
    pattern:
      /\b(?:error|failed) (?:during )?(?:collection|importing|loading)\b|^\s*ERROR collecting\b|no tests ran (?:because )?(?:the )?(?:test)?collect|unhandled error during test collection|\bimport errors?\b/iu,
  },
];

export const attributeVerificationFailure = (
  input: VerificationFailureInput,
): VerificationFailureAttribution => {
  // Expected-file verification without a command: the only thing that can make it fail is the
  // candidate not producing the artifact (the harness pre-validates path escapes separately).
  if (input.expectedFileVerification) {
    return {
      kind: "CANDIDATE_FAILURE",
      evidence: [
        "expected-file verification failed — the candidate did not produce the required artifact",
      ],
      candidateBound: true,
      environmentRetryUseful: false,
    };
  }
  const evidence: string[] = [];
  // Structured execution evidence is authoritative when present (hardening pass #3, Part A): the
  // verifier boundary saw the shell's own error records. COMMAND_NOT_FOUND / SHELL_UNAVAILABLE
  // mean the verifier toolchain itself was unavailable — taxonomy A (VERIFIER_NOT_EXECUTED /
  // TOOLCHAIN_UNAVAILABLE): bounded retry is justified, model repair of the CANDIDATE is not, and
  // a persistent failure fails closed.
  if (input.execution && input.execution.commandResolution === "COMMAND_NOT_FOUND") {
    return {
      kind: "ENVIRONMENT_FAILURE",
      evidence: [
        "structured execution evidence: the verification shell started but the verification command's name did not resolve (CommandNotFoundException / exit-127 shape) — the verifier toolchain is unavailable; the candidate's code cannot cause this",
      ],
      candidateBound: false,
      environmentRetryUseful: true,
    };
  }
  if (input.execution && input.execution.commandResolution === "SHELL_UNAVAILABLE") {
    return {
      kind: "ENVIRONMENT_FAILURE",
      evidence: [
        "structured execution evidence: the verification shell process itself could not be spawned — the verifier toolchain is unavailable; the candidate's code cannot cause this",
      ],
      candidateBound: false,
      environmentRetryUseful: true,
    };
  }
  // Bounded-execution outcomes, from the boundary that imposed the bound. This is checked before
  // any output pattern because the harness's own timer is ground truth and the process's partial
  // output is not: a suite that printed "3 tests failed" and then hung was still stopped by the
  // timeout, and the timeout is the thing that has to be remediated.
  if (input.execution?.termination === "TIMED_OUT") {
    return {
      kind: "EXECUTION_LIMIT_FAILURE",
      evidence: [
        `structured execution evidence: the harness's own timer stopped the verification after ${input.execution.timeoutMs ?? "the configured"} ms — the command did not report a result`,
        "ownership is genuinely ambiguous: a candidate can introduce a hang, and a slow or loaded environment produces the same shape; repair stays available, but re-running the same command unchanged would only spend another full timeout",
      ],
      candidateBound: false,
      environmentRetryUseful: false,
    };
  }
  if (input.execution?.termination === "SIGNALLED") {
    return {
      kind: "EXECUTION_LIMIT_FAILURE",
      evidence: [
        `structured execution evidence: the verification process was terminated by signal ${input.execution.terminatingSignal ?? "(unreported)"} rather than exiting with a result`,
        "a signalled termination is not a test verdict; ownership is not established either way",
      ],
      candidateBound: false,
      environmentRetryUseful: false,
    };
  }
  for (const { kind, evidence: reason, pattern } of failurePatterns) {
    if (pattern.test(input.output)) {
      evidence.push(reason);
      return {
        kind,
        evidence,
        candidateBound: kind === "CANDIDATE_FAILURE",
        // A cheap deterministic re-run only makes sense for shapes that can clear on their own:
        // a cold dependency cache, a service that was briefly unreachable, a toolchain that was
        // mid-install. A candidate failure needs the code to change, and a resource ceiling will
        // be hit again identically.
        environmentRetryUseful: kind !== "CANDIDATE_FAILURE" && kind !== "EXECUTION_LIMIT_FAILURE",
      };
    }
  }
  for (const { evidence: reason, pattern } of ambiguousFailurePatterns) {
    if (pattern.test(input.output)) {
      evidence.push(reason);
      return {
        kind: "UNKNOWN_FAILURE",
        evidence,
        candidateBound: false,
        environmentRetryUseful: true,
      };
    }
  }
  if (input.exitCode === 127 || input.exitCode === 9009) {
    return {
      kind: "ENVIRONMENT_FAILURE",
      evidence: [`exit code ${input.exitCode} — verification command/interpreter not found`],
      candidateBound: false,
      environmentRetryUseful: true,
    };
  }
  return {
    kind: "UNKNOWN_FAILURE",
    evidence: [
      "verification output matched no known failure signature — attribution is honestly unknown",
    ],
    candidateBound: false,
    environmentRetryUseful: true,
  };
};
