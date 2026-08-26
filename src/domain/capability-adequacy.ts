import type { AnalysisCoverage } from "./assurance";

/**
 * Capability adequacy: the layer that makes "a capability PASSed" mean "THIS obligation was
 * established", rather than "some checker in the same bucket returned PASS".
 *
 * The obligation spine introduced by the trust kernel is correct and is preserved verbatim. What
 * this module fixes is the three false-safe merge paths an independent re-audit reproduced against
 * that spine, all of which share one root cause: adequacy was DESCRIPTIVE. The registry documented
 * `doesNotEstablish` in prose, coverage was a property of the LANGUAGE rather than of the
 * capability/obligation pair, and the fold had no mechanical way to ask "does this evidence
 * actually settle this concern, to the depth that was asked for?"
 *
 * The corrections, each traceable to a reproduced path:
 *
 * C1 — PARTIAL coverage was treated as sufficient proof. `PASS` under PARTIAL is now not a
 *      resolution for a MATERIAL obligation: the observation is preserved as evidence, but
 *      uncertainty is not converted into safety.
 * C2 — coverage was language-global ("Python = FULL"), so a scanner that models credential
 *      literals claimed to have established environment-secret exposure in the same file. Coverage
 *      is now stated per (capability, concern, language class) and comes from what the detectors
 *      actually read.
 * C3 — a concern only ever existed if a path keyword raised one, which made file naming a security
 *      boundary. Concern discovery is now structural and language-agnostic, so behaviour in an
 *      unmodelled language can raise a concern that the modelled scanners then cannot discharge.
 * H1 — a credential scanner's PASS resolved an authorization obligation. A capability now resolves
 *      only the concerns it explicitly establishes; everything else it leaves open.
 * H2 — CRITICAL meant "run more cheap checks". It now means "require stronger evidence", expressed
 *      as a minimum evidence strength that lexical scanning cannot meet.
 *
 * What this module deliberately does NOT do: it adds no new list of Ruby/PHP/Go/Python APIs, no
 * framework catalogue and no auth keyword table. Every signal here is a SHAPE. It also never
 * certifies safety — a discovered concern raises an obligation, and only a capability that
 * establishes that concern, at adequate coverage and strength, can settle it.
 */

/**
 * The bounded concern taxonomy. Deliberately small: these are the distinctions that changed a
 * trust outcome in the reproduced audit, not an ontology of everything that can go wrong. Adding a
 * concern is a real decision — each one needs a capability that can establish it or it blocks.
 */
export type ConcernType =
  /** A credential-shaped literal value written into the diff. */
  | "SECURITY.CREDENTIAL_LITERAL"
  /** Concealed/interactive input (a password, a secret prompt) flowing to an exposure sink. */
  | "SECURITY.SENSITIVE_INPUT_FLOW"
  /** A secret read out of the environment or configuration reaching an output sink. */
  | "SECURITY.ENV_SECRET_EXPOSURE"
  /** A known advisory matched a dependency in the exact inventory a provider analyzed. */
  | "SECURITY.DEPENDENCY_VULNERABILITY"
  /** Whether an authorization/permission decision is correct. Nothing in this build establishes it. */
  | "SECURITY.AUTHORIZATION_BEHAVIOR"
  /**
   * The candidate introduced a command/subprocess boundary. Whether the executed string is
   * attacker-influenced is a data-flow question no capability here answers, so this concern is
   * deliberately unestablishable — it exists to stop "nobody asked" from reading as "nothing to ask".
   */
  | "SECURITY.SUBPROCESS_EXECUTION"
  /** Failure behaviour of network/IO boundaries the candidate's own code introduces. */
  | "RESILIENCE.CODE_FAULT_SCENARIO"
  /** Failure behaviour of deployment/operational artefacts a code-content scan cannot read. */
  | "RESILIENCE.OPERATIONAL_ARTEFACT";

/** Plan-level assurance questions. They triage a family; they are not synthetic typed concerns. */
export type AssuranceQuestionType =
  | "DISCOVERY.MATERIAL_CONCERN_SCOPE_ADEQUACY"
  | "SECURITY.MATERIAL_CONCERN_DISCOVERY"
  | "RESILIENCE.MATERIAL_SCENARIO_DISCOVERY"
  | "RESILIENCE.REQUIRED_SCENARIO_EXECUTION";

export type EstablishmentTarget = ConcernType | AssuranceQuestionType;

const concernTypes: ReadonlySet<EstablishmentTarget> = new Set<ConcernType>([
  "SECURITY.CREDENTIAL_LITERAL",
  "SECURITY.SENSITIVE_INPUT_FLOW",
  "SECURITY.ENV_SECRET_EXPOSURE",
  "SECURITY.DEPENDENCY_VULNERABILITY",
  "SECURITY.AUTHORIZATION_BEHAVIOR",
  "SECURITY.SUBPROCESS_EXECUTION",
  "RESILIENCE.CODE_FAULT_SCENARIO",
  "RESILIENCE.OPERATIONAL_ARTEFACT",
]);

/** Distinguishes exact concern witnesses from plan-level assurance questions at adapter ingress. */
export const isConcernType = (target: EstablishmentTarget): target is ConcernType =>
  concernTypes.has(target);

/** Whether evidence asserts a concrete finding or the absence of one. */
export type EvidenceClaim = "POSITIVE_FINDING" | "NEGATIVE_ABSENCE";

/**
 * Completeness is meaningful only for negative evidence. A positive finding carries its own
 * witness; a negative claim must identify a bounded scope and prove that scope was completely
 * enumerated before silence can become PASS.
 */
export type EvidenceCompleteness = "NOT_APPLICABLE" | "COMPLETE" | "INCOMPLETE";

/**
 * How strong a piece of evidence is. Ordered: each rung can satisfy a demand for itself or lower.
 *
 * LEXICAL     a vocabulary/regex match over text. Cheap, and honest only about text.
 * STRUCTURAL  a code shape was resolved — a binding, a call form, a source→sink pairing.
 * BEHAVIORAL  the construct's behaviour was reasoned about in a language the checker models.
 * MEASURED    the property was executed and observed against this candidate id and diff digest.
 */
export type EvidenceStrength = "LEXICAL" | "STRUCTURAL" | "BEHAVIORAL" | "MEASURED";

const strengthRank: Record<EvidenceStrength, number> = {
  LEXICAL: 0,
  STRUCTURAL: 1,
  BEHAVIORAL: 2,
  MEASURED: 3,
};

export const meetsStrength = (actual: EvidenceStrength, required: EvidenceStrength): boolean =>
  strengthRank[actual] >= strengthRank[required];

/**
 * Language classes, grouped by what the deterministic scanners STRUCTURALLY read — not by
 * popularity or by whether a parser exists. The class is the unit coverage is stated against,
 * which is what stops "Python = FULL" from meaning "every Python security question is settled".
 */
export type LanguageClass =
  /** The JS/TS family: the constructs in semantic-sensitivity.ts were written against these. */
  | "TS_JS"
  /** Python: modelled for concealed input and credential binding idioms. */
  | "PYTHON"
  /** POSIX shell: modelled for `read -s` style concealed input. */
  | "SHELL"
  /** Scripting languages where generic binding/naming shapes transfer but idioms do not. */
  | "GENERIC_SCRIPTING"
  /** Typed languages with a deliberately bounded declaration-only promotion grammar. */
  | "BOUNDED_COMPILED"
  /** Compiled/typed languages whose binding and concealed-input forms share no modelled shape. */
  | "UNMODELLED"
  /** Config/workflow files whose added lines define commands or execution steps. */
  | "CONFIG_WORKFLOW";

const languageClassPatterns: Array<{ class: LanguageClass; pattern: RegExp }> = [
  { class: "TS_JS", pattern: /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro)$/iu },
  { class: "PYTHON", pattern: /\.(?:py|pyi)$/iu },
  { class: "SHELL", pattern: /\.(?:sh|bash|zsh)$/iu },
  {
    class: "GENERIC_SCRIPTING",
    pattern: /\.(?:rb|php|pl|lua|r|jl|ex|exs|ps1|psm1|fish|hbs|ejs|erb|j2|twig|pug)$/iu,
  },
  {
    class: "BOUNDED_COMPILED",
    pattern: /\.(?:go|rs|kt|kts|swift)$/iu,
  },
  {
    class: "UNMODELLED",
    pattern: /\.(?:java|c|h|cc|cpp|hpp|cs|scala|clj|erl|hs|ml|mli|dart|sql|mk|gradle)$/iu,
  },
  { class: "CONFIG_WORKFLOW", pattern: /\.(?:ya?ml|toml|ini|cfg|conf)$/iu },
];

/**
 * Classifies a file. Unknown extensions are UNMODELLED — the fail-safe direction: a file whose
 * class we cannot name is a file whose idioms we certainly do not model.
 */
export const languageClassOf = (file: string): LanguageClass => {
  for (const entry of languageClassPatterns) {
    if (entry.pattern.test(file)) return entry.class;
  }
  return "UNMODELLED";
};

/** Capability identifiers, split from the single broad Security scanner (Part G). */
export type AdequacyCapabilityId =
  | "DISCOVERY.CONCERN_WITNESS"
  | "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER"
  | "SECURITY.CREDENTIAL_LITERAL_SCAN"
  | "SECURITY.CONCERN_DISCOVERY"
  | "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER"
  | "SECURITY.SEMANTIC_FLOW_SCAN"
  | "SECURITY.DEPENDENCY_VULNERABILITY_SCAN"
  | "RESILIENCE.CODE_RELEVANCE_SCAN"
  | "RESILIENCE.FAULT_SCENARIO_EXECUTION";

export interface CapabilityEstablishment {
  /** The exact concern or assurance question this capability can speak to at all. */
  concern: EstablishmentTarget;
  /** The strongest evidence this capability produces for that concern. */
  strength: EvidenceStrength;
  /** Which direction of claim this capability may make for this exact target. */
  claims: EvidenceClaim[];
  /**
   * Coverage for THIS concern, per language class, for the claims listed.
   * Stated from what the detectors actually read, never from "a parser exists".
   *
   * For POSITIVE_FINDING, FULL means the capability can recognise the modelled signal in-scope.
   * That is not a licence to treat silence as absence.
   */
  coverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
  /**
   * Coverage for NEGATIVE_ABSENCE claims. Omitted means "same as `coverage`".
   * Positive detection can be stronger than absence proof; collapsing those recreates
   * false confidence. FULL here means silence is meaningful evidence of absence inside
   * the capability's explicitly bounded scope.
   */
  negativeCoverage?: Partial<Record<LanguageClass, AnalysisCoverage>>;
}

/**
 * The adequacy matrix. Every claim below is deliberately narrow.
 *
 * Note what the credential-literal scanner establishes: a literal written into the diff, and
 * nothing else. It reads text, so it works the same in every language — which is exactly why its
 * PASS must not settle a flow, environment or authorization question. That single distinction is
 * finding H1.
 */
const establishments: Record<AdequacyCapabilityId, CapabilityEstablishment[]> = {
  // Promotion-facing discovery adequacy is not a Security bucket. A concrete witness proves only
  // that typed work exists. It may resolve the scope obligation only when the discovery result's
  // independent unit accounting says the entire relevant changed scope has no remainder.
  "DISCOVERY.CONCERN_WITNESS": [
    {
      concern: "DISCOVERY.MATERIAL_CONCERN_SCOPE_ADEQUACY",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "FULL",
        UNMODELLED: "FULL",
        CONFIG_WORKFLOW: "FULL",
      },
      negativeCoverage: {
        TS_JS: "UNSUPPORTED",
        PYTHON: "UNSUPPORTED",
        SHELL: "UNSUPPORTED",
        GENERIC_SCRIPTING: "UNSUPPORTED",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
  ],
  // A language-neutral structural classifier for a deliberately closed set of changed-local
  // forms. Syntax labels are broader than promotion authority: only newly added plain numeric
  // constants, newly added unquoted local scalar observations, erased/name-resolution-only
  // imports, and empty executable scope can support its negative PASS. Arbitrary calls are
  // excluded even when every argument is literal. Removed data/computation, exported or textual
  // fixed data, and syntax classification by itself establish no absence. The bounded claim says
  // nothing about unchanged consumers.
  "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER": [
    {
      concern: "DISCOVERY.MATERIAL_CONCERN_SCOPE_ADEQUACY",
      strength: "STRUCTURAL",
      claims: ["NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "UNSUPPORTED",
        BOUNDED_COMPILED: "FULL",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
  ],
  // A textual scan for credential-shaped literals. Language-independent because it is lexical:
  // it looks for `name = "value"` shapes with credential-shaped names, which survive syntax.
  "SECURITY.CREDENTIAL_LITERAL_SCAN": [
    {
      concern: "SECURITY.CREDENTIAL_LITERAL",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "FULL",
        GENERIC_SCRIPTING: "FULL",
        BOUNDED_COMPILED: "PARTIAL",
        // A literal assignment is recognisable in a typed language too (`var x string = "..."`),
        // but const blocks, struct tags and raw string forms are not all modelled.
        UNMODELLED: "PARTIAL",
        CONFIG_WORKFLOW: "PARTIAL",
      },
    },
  ],
  // A bounded statement/call/boolean-context pass that decides whether a plan-level Security
  // question needs to be refined into typed obligations. It establishes only that triage question,
  // never authorization correctness, flow safety, or subprocess input provenance.
  "SECURITY.CONCERN_DISCOVERY": [
    {
      concern: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
      strength: "STRUCTURAL",
      // This detector can raise a concrete concern. Its bounded vocabulary cannot prove that no
      // security concern exists, even when it read every byte in the diff. Detection coverage may
      // be FULL; negative coverage is UNSUPPORTED because silence is not absence.
      claims: ["POSITIVE_FINDING"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "FULL",
        UNMODELLED: "FULL",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
      negativeCoverage: {
        TS_JS: "UNSUPPORTED",
        PYTHON: "UNSUPPORTED",
        SHELL: "UNSUPPORTED",
        GENERIC_SCRIPTING: "UNSUPPORTED",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
  ],
  // A separate negative capability with a deliberately smaller claim: every relevant changed
  // unit was exhaustively concern-covered or had an exact bounded claim with promotion authority.
  // A FIXED_DATA_DECLARATION or LOCAL_SCALAR_COMPUTATION label alone is metadata, not absence.
  "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER": [
    {
      concern: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
      strength: "STRUCTURAL",
      claims: ["NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "UNSUPPORTED",
        BOUNDED_COMPILED: "FULL",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
  ],
  // Dependency inventories and lockfiles do not align with source-language classes. Until the
  // coverage model has a dependency-scope axis, this capability can carry concrete positive
  // findings but no negative-absence claim: scanner silence is bounded to the inventory sources
  // reported by that invocation and can never become generic Security PASS.
  "SECURITY.DEPENDENCY_VULNERABILITY_SCAN": [
    {
      concern: "SECURITY.DEPENDENCY_VULNERABILITY",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING"],
      coverage: {
        TS_JS: "PARTIAL",
        PYTHON: "PARTIAL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "PARTIAL",
        UNMODELLED: "PARTIAL",
        CONFIG_WORKFLOW: "PARTIAL",
      },
      negativeCoverage: {
        TS_JS: "UNSUPPORTED",
        PYTHON: "UNSUPPORTED",
        SHELL: "UNSUPPORTED",
        GENERIC_SCRIPTING: "UNSUPPORTED",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
  ],
  // The semantic scanner: concealed-input constructs, credential bindings, and source→sink pairs.
  // This is where C2 bites — it models SOME Python security shapes, not all of them.
  "SECURITY.SEMANTIC_FLOW_SCAN": [
    {
      concern: "SECURITY.SENSITIVE_INPUT_FLOW",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "FULL",
        SHELL: "FULL",
        // Generic binding/naming shapes transfer; the language's own concealed-input idioms
        // (`$stdin.noecho`, `readline` with echo off) do not. This is finding C1.
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
    {
      // Finding C2: environment-secret exposure is NOT settled by the constructs this scanner
      // models, even in Python. `os.environ.get("API_TOKEN")` reaching `print` is recognised only
      // when the identifier is credential-shaped and the sink is one of the modelled sinks;
      // indirection through a helper, a dict, or a formatter is not read at all.
      concern: "SECURITY.ENV_SECRET_EXPOSURE",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "PARTIAL",
        PYTHON: "PARTIAL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
    // Deliberately absent: SECURITY.AUTHORIZATION_BEHAVIOR. No capability in this build evaluates
    // whether an authorization decision is CORRECT, in any language. Its absence from every
    // capability's establishment list is what makes the obligation block rather than resolve
    // (finding H1) — nothing has to be added to a gate list for that to happen.
  ],
  // A content scan over the candidate's CODE for network/IO boundaries needing fault scenarios.
  "RESILIENCE.CODE_RELEVANCE_SCAN": [
    {
      concern: "RESILIENCE.MATERIAL_SCENARIO_DISCOVERY",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "PARTIAL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
    {
      concern: "RESILIENCE.CODE_FAULT_SCENARIO",
      strength: "STRUCTURAL",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: {
        TS_JS: "FULL",
        PYTHON: "PARTIAL",
        SHELL: "PARTIAL",
        GENERIC_SCRIPTING: "PARTIAL",
        BOUNDED_COMPILED: "UNSUPPORTED",
        UNMODELLED: "UNSUPPORTED",
        CONFIG_WORKFLOW: "UNSUPPORTED",
      },
    },
    // Deliberately absent: RESILIENCE.OPERATIONAL_ARTEFACT (Part H). "No fetch() in the source"
    // says nothing about a deploy manifest's failure behaviour, so a code-content scan cannot
    // discharge a deployment concern.
  ],
  // Executed fault injection, bound to candidate id + diff digest. The only MEASURED evidence here.
  "RESILIENCE.FAULT_SCENARIO_EXECUTION": [
    {
      concern: "RESILIENCE.REQUIRED_SCENARIO_EXECUTION",
      strength: "MEASURED",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: { TS_JS: "FULL", PYTHON: "FULL", SHELL: "FULL", GENERIC_SCRIPTING: "FULL" },
    },
    {
      concern: "RESILIENCE.CODE_FAULT_SCENARIO",
      strength: "MEASURED",
      claims: ["POSITIVE_FINDING", "NEGATIVE_ABSENCE"],
      coverage: { TS_JS: "FULL", PYTHON: "FULL", SHELL: "FULL", GENERIC_SCRIPTING: "FULL" },
    },
  ],
};

export interface AdequacyVerdict {
  /** Whether this capability speaks to this concern at all. */
  establishes: boolean;
  /** Coverage for this concern across the given language classes; worst class wins. */
  coverage: AnalysisCoverage;
  strength: EvidenceStrength | null;
  reason: string;
}

const coverageRank: Record<AnalysisCoverage, number> = {
  UNSUPPORTED: 0,
  PARTIAL: 1,
  FULL: 2,
  NOT_APPLICABLE: 3,
};

/**
 * Coverage for a concern across a set of touched language classes. The WORST class wins: one
 * unreadable file cannot be laundered by a readable one, which is the same rule the scan-wide
 * coverage combiner already applies, restated per concern.
 */
export const capabilityCoverageFor = (
  capability: AdequacyCapabilityId,
  concern: EstablishmentTarget,
  classes: LanguageClass[],
  claim: EvidenceClaim = "POSITIVE_FINDING",
): AdequacyVerdict => {
  const entry = establishments[capability].find((item) => item.concern === concern);
  if (!entry) {
    return {
      establishes: false,
      coverage: "UNSUPPORTED",
      strength: null,
      reason: `${capability} does not establish ${concern}; a PASS from it is evidence about a different question`,
    };
  }
  if (classes.length === 0) {
    return {
      establishes: true,
      coverage: "NOT_APPLICABLE",
      strength: entry.strength,
      reason: `${capability} establishes ${concern}, but no material of a relevant language class changed`,
    };
  }
  const coverageByClass =
    claim === "NEGATIVE_ABSENCE" ? (entry.negativeCoverage ?? entry.coverage) : entry.coverage;
  let worst: AnalysisCoverage = "NOT_APPLICABLE";
  for (const languageClass of classes) {
    const coverage = coverageByClass[languageClass] ?? "UNSUPPORTED";
    if (coverageRank[coverage] < coverageRank[worst]) worst = coverage;
  }
  return {
    establishes: true,
    coverage: worst,
    strength: entry.strength,
    reason: `${capability} establishes ${concern} at ${worst} coverage over ${classes.join(", ")} for ${claim} (evidence strength ${entry.strength})`,
  };
};

/** Every capability that establishes a concern, for reporting which gap needs closing. */
export const capabilitiesEstablishing = (concern: EstablishmentTarget): AdequacyCapabilityId[] =>
  (Object.keys(establishments) as AdequacyCapabilityId[]).filter((capability) =>
    establishments[capability].some((entry) => entry.concern === concern),
  );

/** A producer may speak only in a direction its establishment contract explicitly permits. */
export const capabilitySupportsEvidenceClaim = (
  capability: AdequacyCapabilityId,
  concern: EstablishmentTarget,
  claim: EvidenceClaim,
): boolean =>
  establishments[capability].some(
    (entry) => entry.concern === concern && entry.claims.includes(claim),
  );

/**
 * Maximum negative-absence coverage a provider may claim for a capability as a whole. Provider
 * output can narrow this ceiling, never widen it. Every establishment target must authorize a
 * negative claim; one positive-only target makes generic scanner silence UNSUPPORTED.
 */
export const capabilityNegativeAbsenceCeiling = (
  capability: string,
  classes: LanguageClass[],
): AnalysisCoverage => {
  if (!Object.hasOwn(establishments, capability)) return "UNSUPPORTED";
  const entries = establishments[capability as AdequacyCapabilityId];
  if (entries.length === 0 || entries.some((entry) => !entry.claims.includes("NEGATIVE_ABSENCE"))) {
    return "UNSUPPORTED";
  }
  let worst: AnalysisCoverage = classes.length === 0 ? "NOT_APPLICABLE" : "FULL";
  for (const entry of entries) {
    const coverageByClass = entry.negativeCoverage ?? entry.coverage;
    for (const languageClass of classes) {
      const coverage = coverageByClass[languageClass] ?? "UNSUPPORTED";
      if (coverageRank[coverage] < coverageRank[worst]) worst = coverage;
    }
  }
  return worst;
};
