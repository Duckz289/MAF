// WHICH WORLD IS THIS PROCESS RUNNING IN -- stated explicitly, proven at runtime.
//
// THE DEFECT THIS REPLACES
// -----------------------
// The first Runner v2 revision derived TEST vs PRODUCTION from ambient environment variables
// (`VITEST`, `NODE_ENV`, `npm_lifecycle_event`, ...). That is a mutable, inherited signal set:
// anything able to shape a child process environment can shape the classification, and a sanitized
// environment silently reclassified a test as PRODUCTION. Trust cannot rest on a value the caller
// controls.
//
// THE RULE NOW
// ------------
// The execution context is an explicitly CONSTRUCTED, runtime-authentic object:
//
//   PRODUCTION  built by the production CLI, and by nothing else, via
//               `createProductionExecutionContext()`.
//   TEST        obtained only through the internal test-support seam in `lib/internal/`, which the
//               production CLI never imports. There is deliberately NO `--test-mode` flag: an
//               operator cannot convert a production invocation into a test one from the command
//               line.
//
// Authenticity is enforced by a module-private `WeakSet`, not by a TypeScript brand. A brand is
// erased at emit and buys nothing at runtime: a plain object literal, an object spread, an
// `Object.assign` clone and a JSON round-trip all satisfy a branded interface after a cast. None of
// them can be in this WeakSet, because only the factories below ever add to it and neither exposes
// a primitive that registers a caller-supplied object.
//
// AMBIENT ENVIRONMENT IS ADVISORY, AND CAN ONLY EVER REFUSE
// --------------------------------------------------------
// Ambient signals are still OBSERVED, recorded and printed -- they are just not the trust root.
// They are wired in exactly one direction: a context claiming PRODUCTION while the environment
// plainly shows a test harness is a CONTRADICTION and fails closed (`ambientContradiction`). No
// environment value can grant capability, relax a check, or turn a TEST context into a PRODUCTION
// one. Stripping every variable therefore leaves an explicit TEST context TEST, and leaves a
// genuine production run unaffected.
//
// That asymmetry is what preserves the incident regression while satisfying the audit: a test which
// drives the production command without a test seam claims PRODUCTION, contradicts its own
// environment, and is refused before anything resolves.

/** The two worlds. There is no third, and no default. */
export type ExecutionContextKind = "PRODUCTION" | "TEST";

/** What the environment happens to look like. Recorded for the operator; never trusted. */
export interface AmbientObservation {
  readonly signals: readonly string[];
  /** True when at least one test-harness signal is present. Advisory only. */
  readonly looksLikeTest: boolean;
  readonly detail: string;
}

export interface ExecutionContext {
  readonly kind: ExecutionContextKind;
  /** Who constructed this context. Reported in refusals so a surprise is traceable. */
  readonly origin: string;
  readonly createdAt: string;
  /** The environment as it looked when this context was constructed. Advisory. */
  readonly ambient: AmbientObservation;
  /** Advisory alias of `ambient.signals`, kept for report and message formatting. */
  readonly signals: readonly string[];
  readonly detail: string;
}

/**
 * The runtime authenticity registry.
 *
 * Module-private and never exported in any form -- not the set, not an `add`, not a "register this
 * object for me" helper. The only members are objects `mint` created below, so membership is proof
 * of provenance rather than proof of shape.
 */
const AUTHENTIC_EXECUTION_CONTEXTS = new WeakSet<object>();

/**
 * Environment keys that indicate a test harness.
 *
 * Deliberately wide. Being over-broad costs at most a refusal (a PRODUCTION claim that contradicts
 * its own environment), never money, and never the reverse.
 */
const observeSignals = (environment: NodeJS.ProcessEnv): string[] => {
  const signals: string[] = [];
  const present = (key: string): boolean => {
    const raw = environment[key];
    return typeof raw === "string" && raw.length > 0;
  };

  if (present("VITEST")) signals.push("VITEST");
  if (present("VITEST_WORKER_ID")) signals.push("VITEST_WORKER_ID");
  if (present("VITEST_POOL_ID")) signals.push("VITEST_POOL_ID");
  if (present("JEST_WORKER_ID")) signals.push("JEST_WORKER_ID");
  if (present("NODE_TEST_CONTEXT")) signals.push("NODE_TEST_CONTEXT");
  if (environment.NODE_ENV === "test") signals.push("NODE_ENV=test");

  const lifecycle = environment.npm_lifecycle_event ?? "";
  if (/^(test|test:watch|validate)$/u.test(lifecycle)) {
    signals.push(`npm_lifecycle_event=${lifecycle}`);
  }
  const lifecycleScript = environment.npm_lifecycle_script ?? "";
  if (/\bvitest\b|\bjest\b/u.test(lifecycleScript)) signals.push("npm_lifecycle_script");

  // An explicit declaration is still only a SIGNAL. It can contribute to a contradiction (the safe
  // direction) and can never construct, relax or upgrade a context.
  if (environment.MAF_SCORING_EXECUTION_CONTEXT === "TEST") {
    signals.push("MAF_SCORING_EXECUTION_CONTEXT=TEST");
  }
  return signals;
};

/** Reads the environment for advisory test-harness signals. Constructs nothing and trusts nothing. */
export const observeAmbientTestSignals = (
  environment: NodeJS.ProcessEnv = process.env,
): AmbientObservation => {
  const signals = observeSignals(environment);
  return Object.freeze({
    signals: Object.freeze([...signals]),
    looksLikeTest: signals.length > 0,
    detail:
      signals.length > 0
        ? `ambient test-harness signals observed: ${signals.join(", ")} (advisory only)`
        : "no ambient test-harness signal observed (advisory only)",
  });
};

const mint = (
  kind: ExecutionContextKind,
  origin: string,
  environment: NodeJS.ProcessEnv,
): ExecutionContext => {
  const ambient = observeAmbientTestSignals(environment);
  const context: ExecutionContext = Object.freeze({
    kind,
    origin,
    createdAt: new Date().toISOString(),
    ambient,
    signals: ambient.signals,
    detail:
      `${kind} execution context, explicitly constructed by ${origin}; ${ambient.detail}. ` +
      "The environment did not decide this classification and cannot change it.",
  });
  AUTHENTIC_EXECUTION_CONTEXTS.add(context);
  return context;
};

/**
 * Constructs the PRODUCTION execution context.
 *
 * The production CLI calls this unconditionally, with no flag able to divert it. Note what is NOT
 * here: no way to ask for TEST, no environment consultation that could yield TEST, and no parameter
 * whose value changes the kind.
 */
export const createProductionExecutionContext = (
  origin = "production-cli",
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionContext => mint("PRODUCTION", origin, environment);

/**
 * INTERNAL -- the ONLY route to a TEST execution context.
 *
 * Re-exported by `lib/internal/test-support.ts` and reached from nowhere else. Production sources
 * must never name this symbol; `tests/scoring-runner-v2-isolation.test.ts` asserts they do not, so
 * the separation is a checked property of the tree rather than a convention.
 */
export const __INTERNAL_mintTestExecutionContext = (
  origin: string,
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionContext => mint("TEST", origin, environment);

/** Runtime authenticity predicate. Reading membership is safe to export; adding is not. */
export const isAuthenticExecutionContext = (value: unknown): value is ExecutionContext =>
  typeof value === "object" && value !== null && AUTHENTIC_EXECUTION_CONTEXTS.has(value);

/** Throws unless `value` was produced by one of this module's factories. */
export function assertAuthenticExecutionContext(
  value: unknown,
  where: string,
): asserts value is ExecutionContext {
  if (!isAuthenticExecutionContext(value)) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: ${where} received an execution context that this process did ` +
        "not construct. A context must be minted by createProductionExecutionContext() or by the " +
        "internal test-support seam; a hand-written object, a spread or Object.assign clone, and a " +
        "JSON round-trip are all refused, because authenticity is a runtime registration rather " +
        "than a TypeScript type.",
    );
  }
}

/**
 * The one direction ambient environment is allowed to act in: refusal.
 *
 * Returns a reason when the claimed context disagrees with a plainly-observable test harness, and
 * null otherwise. A TEST context with a spotless environment is NOT a contradiction -- that is the
 * sanitized-environment case, and explicit construction is exactly what must survive it.
 */
export const ambientContradiction = (
  context: ExecutionContext,
  environment: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (context.kind !== "PRODUCTION") return null;
  const ambient = observeAmbientTestSignals(environment);
  if (!ambient.looksLikeTest) return null;
  return (
    `a PRODUCTION execution context (constructed by ${context.origin}) was presented while the ` +
    `environment plainly shows a test harness (${ambient.signals.join(", ")}). Ambient environment ` +
    "cannot grant PRODUCTION status, so this disagreement fails closed rather than resolving in " +
    "favour of either side. It is the exact shape of incident " +
    "maf-scoring-incident-2026-09-03-v1: a test reaching the production execution path."
  );
};

/** Throws on a contradiction. Used at the spawn boundary and by the real-provider constructor. */
export const assertNoAmbientContradiction = (
  context: ExecutionContext,
  environment: NodeJS.ProcessEnv = process.env,
): void => {
  const contradiction = ambientContradiction(context, environment);
  if (contradiction) throw new Error(`SCORING_EXECUTION_REFUSED: ${contradiction}`);
};

/** Human-readable one-liner for gate and report output. */
export const describeExecutionContext = (context: ExecutionContext | null): string =>
  context === null
    ? "NONE"
    : `${context.kind} (origin=${context.origin}; ${context.ambient.detail})`;
