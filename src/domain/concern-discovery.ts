import type { AnalysisCoverage } from "./assurance";
import type { ConcernType, EvidenceCompleteness, LanguageClass } from "./capability-adequacy";
import { languageClassOf } from "./capability-adequacy";
import { parseFilePatches, type FilePatch } from "./diff-parse";
import {
  classifyBoundedDiscoveryStatement,
  declarationLanguageOf,
  directLocalCallExpression,
  directSourceCallArgumentsCovered,
  dynamicArgumentCallSites,
  dynamicCommandBoundary,
  establishesPromotionAbsence,
  extractLocalCallSites,
  extractSimpleLocalBinding,
  identifierOccursIn,
  isFixedDataDeclaration,
  isFullyCoveredLocalObservation,
  isProvenCommentLine,
  isProvenEffectFreeScalarExpression,
  splitLocalStatements,
  type BoundedDiscoveryStatementClass,
  type DeclarationLanguage,
} from "./local-code-semantics";
import { deriveSemanticSensitivity } from "./semantic-sensitivity";
import { credentialLiteralAssignments } from "./security";

/**
 * Cross-language concern discovery (Part D, finding C3).
 *
 * Before this module, a security concern existed almost exclusively because a PATH KEYWORD matched
 * — `auth/`, `session/`, `credential/`. That made file naming a security boundary: a Go file at
 * `cmd/server.go` reading a password off the terminal and logging it raised nothing at all, so
 * SECURITY resolved NOT_REQUIRED and the candidate merged. Unsupported analysis failed closed only
 * AFTER some other heuristic had already created the obligation, which is precisely backwards.
 *
 * The fix is to separate two things the old design conflated:
 *
 *   BEHAVIORAL POSSIBILITY   this file could contain sensitive behaviour
 *   MATERIAL CONCERN         this diff contains a shape that raises a specific typed question
 *   SCOPE ADEQUACY           the changed scope was classified well enough for safe promotion
 *
 * A concrete shape raises its typed obligation. Separately, explicit scope incompleteness raises
 * discovery adequacy; it cannot disappear merely because the planner missed Security. Progression
 * comes from the bounded statement classifier, not from treating unsupported detector silence as
 * absence.
 *
 * Every detector below is a SHAPE, not an API list. This is a deliberate constraint: an audit that
 * can be defeated by writing `rpassword::read_password()` instead of `term.ReadPassword()` has not
 * been fixed, it has been memorised. The shapes used are:
 *
 *   - an identifier whose NAME is credential-shaped participating in a binding or a call argument
 *   - an environment/config read, in any of the handful of universal syntactic forms
 *   - a value flowing into an output/log/print sink on the same or a nearby line
 *   - a call whose name encodes concealment (read-password, hidden, noecho, masked)
 *   - an authorization/permission decision shape (a check returning or branching on permission)
 *
 * These carry across Go, Rust, Ruby, PHP, Java and languages nobody here has thought about,
 * because identifier naming, assignment, call syntax and output sinks are near-universal. A shape
 * match does NOT assert a vulnerability. It asserts a QUESTION — and a question that no available
 * capability can answer stays unresolved rather than becoming a pass.
 */

export interface DiscoveredConcern {
  concern: ConcernType;
  file: string;
  languageClass: LanguageClass;
  /** The shape that raised it, quoted for evidence. Never the whole line's secret content. */
  evidence: string;
  /** Raw predicate atoms that this exact concern obligates a producer to decide. */
  obligationAtomIdentities: string[];
}

export type RawScopeDispositionKind =
  | "ANALYZED"
  | "UNSUPPORTED"
  | "UNCLASSIFIED_RESIDUAL"
  | "PROVEN_IRRELEVANT";

export interface RawScopeAtomDisposition {
  atomIdentity: string;
  file: string;
  atomKind: "ADDED_TEXT" | "REMOVED_TEXT" | "GIT_METADATA" | "UNPARSED_PATCH";
  disposition: RawScopeDispositionKind;
  reason: string;
}

/**
 * Explicit accounting for the changed-local unit used by discovery adequacy. Counts are
 * candidate-wide, but attribution is unit-local: a concern or bounded class in one statement
 * cannot account for a sibling statement or another file. Concern/bounded counts may overlap;
 * unsupported and unclassified counts are the unresolved remainder after attribution.
 */
export interface DiscoveryScopeAccounting {
  unit: "CHANGED_LOCAL_STATEMENT";
  totalRelevantUnits: number;
  /** Any unit touched by a concern witness, including partial coverage. */
  concernAttributedUnits: number;
  /** Units for which concern analysis proves the whole unit is inside its typed scope. */
  concernCoveredUnits: number;
  /** Concern-attributed units that retain an opaque or otherwise unconsumed sibling region. */
  partiallyConcernCoveredUnits: number;
  /** Every unit assigned a bounded syntax label, whether or not that label has absence authority. */
  syntaxClassifiedUnits: number;
  /** Compatibility count for promotion-grade bounded classification. */
  boundedClassifiedUnits: number;
  /** Units whose exact syntax/change-direction claim independently establishes absence. */
  promotionAbsenceEstablishedUnits: number;
  /** Metadata only. These units are not included in boundedClassifiedUnits. */
  fixedArgumentInvocationUnits: number;
  unsupportedUnits: number;
  unclassifiedRemainderUnits: number;
  /** Complete conservation ledger for raw candidate material before statement filtering. */
  rawChangedAtoms: number;
  analyzedRawAtoms: number;
  unsupportedRawAtoms: number;
  unclassifiedRawAtoms: number;
  provenIrrelevantRawAtoms: number;
  rawAtomDispositions: RawScopeAtomDisposition[];
  /** True only for a truly empty patch or when every raw atom has positive irrelevance proof. */
  emptyScopeProven: boolean;
  /**
   * The exact identities of the units this accounting describes (P1.3).
   *
   * Counts alone are not a scope binding: a producer claiming "10/10 units covered" could have
   * analyzed a DIFFERENT set of 10 units. Promotion-authoritative stronger discovery evidence must
   * name the concrete scope it claims, so consumers can verify identity rather than arithmetic.
   * Ordered and candidate-derived, so the value is stable for the same diff.
   */
  unitIdentities: string[];
  /** Identities of the units that remain unsupported or unclassified after attribution. */
  residualUnitIdentities: string[];
  concernsFound: boolean;
  discoveryIncomplete: boolean;
  complete: boolean;
}

export interface ConcernDiscoveryResult {
  concerns: DiscoveredConcern[];
  /** Language classes of the production files this diff actually changed. */
  touchedClasses: LanguageClass[];
  /** Coverage of the bounded statement/call-shape discovery, independent of its findings. */
  coverage: AnalysisCoverage;
  /** Whether the result is a finding, a complete bounded absence proof, or detector silence. */
  conclusion: "CONCERNS_FOUND" | "ABSENCE_ESTABLISHED" | "INCOMPLETE";
  /** Negative completeness. Positive findings do not need an absence proof. */
  completeness: EvidenceCompleteness;
  /** The exact bounded scope to which completeness applies. */
  analysisScope: string;
  /**
   * Promotion-facing adequacy of the changed scope. This is distinct from the plan Security
   * question: it records whether concern discovery produced typed work, a completely classified
   * bounded scope, or an explicit epistemic gap that must become its own obligation.
   */
  scopeAdequacy: {
    conclusion: "CONCERNS_FOUND" | "ABSENCE_ESTABLISHED" | "INCOMPLETE";
    completeness: EvidenceCompleteness;
    coverage: AnalysisCoverage;
    analysisScope: string;
    evidence: string[];
  };
  /** Promotion-facing accounting for every relevant changed-local unit. */
  scopeAccounting: DiscoveryScopeAccounting;
  evidence: string[];
}

/**
 * Paths whose contents are conventionally not production behaviour.
 *
 * This filter is deliberately NARROW, and the narrowness is a correction: an adversarial probe of
 * this module reached MERGE_ELIGIBLE by putting a real command-execution boundary in
 * `docs/runtime/exec.ts` and in `tests/helpers/exec.ts`. Excluding a whole subtree by name makes
 * file naming a security boundary again — the exact anti-pattern finding C3 exists to remove — and
 * "vendored" or "example" directories routinely contain code that really runs.
 *
 * So the exclusion now applies only to material that is not executable source at all (documentation
 * and fixture DATA), plus dependency trees the candidate does not author. Executable source keeps
 * being read wherever it lives: a test helper that shells out is still code that shells out, and
 * whether that matters is a question for the obligation fold, not for a path regex.
 */
const nonProductionPath = /(^|\/)(?:node_modules|vendor)\//iu;

/** Formats for which this build has a small positive plain-prose recognizer. */
const proseCapableFile = /\.(?:md|markdown|mdx|rst|txt)$/iu;

/** Opaque/data formats have no negative analyzer in this build; the extension grants no PASS. */
const unsupportedDataFile = /\.(?:lock|snap|csv|png|jpe?g|gif|ico|woff2?|ttf)$/iu;

/** Small, explicit hybrid set whose changed text can embed executable syntax. */
const inspectableExecutableHybridFile = /\.(?:mdx|svg)$/iu;

/**
 * Executable-capable hybrid classification.
 *
 * EMPTY_EXECUTABLE_SCOPE is promotion-authoritative, so its producer needs a POSITIVE reason to
 * know that changed material is not executable. The previous form was the opposite polarity —
 * "nothing matched my executable regex, therefore inert" — which let structurally novel executable
 * forms (JSX fragments in MDX, namespaced `<svg:script>`, animation elements carrying event
 * attributes) vanish before accounting (RC3b).
 *
 * The three-way contract replaces it:
 *
 *   INERT       recognized as clearly non-executable content → may be excluded
 *   EXECUTABLE  recognized executable syntax → analyze, and force UNSUPPORTED adequacy
 *   AMBIGUOUS   inspectable structural content nobody recognized → UNSUPPORTED, never empty
 */
type HybridClassification = "INERT" | "EXECUTABLE" | "AMBIGUOUS";

/** Markup/structural syntax: any tag, entity, expression brace, or processing instruction. */
const hybridStructuralSyntax = /<[^>]|>|\{|\}|&[A-Za-z#][\w#]*;/u;

/**
 * A deliberately positive prose grammar. It accepts ordinary sentences, not "anything for which
 * no executable regex fired". Structural markup, directives, assignments, schemes, fences, and
 * frontmatter therefore remain ambiguous and explicit.
 */
const isPositivelyPlainProse = (lines: string[]): boolean => {
  const material = lines.filter((line) => line.trim() !== "");
  if (material.length === 0) return true;
  return material.every((line) => {
    const trimmed = line.trim();
    const prose = trimmed.match(/^#{1,6}\s+(.+)$/u)?.[1] ?? trimmed;
    return (
      /[\p{L}\p{N}]/u.test(prose) &&
      !/[#*`~<>{}|\\]/u.test(prose) &&
      !prose.includes("[") &&
      !prose.includes("]") &&
      !/(?:^|\s)(?:---|\.\.\.|:::)(?:\s|$)/u.test(prose) &&
      !/(?:javascript|data|file|command|vscode|shell):/iu.test(prose) &&
      !/(?::=|==|=>|\b\w+\s*=)/u.test(prose) &&
      !trimmed.startsWith("#!")
    );
  });
};

const classifyHybridContent = (file: string, lines: string[]): HybridClassification => {
  const changedText = lines.join("\n");
  if (changedText.trim() === "") return "INERT";
  if (/\.mdx$/iu.test(file)) {
    if (
      /^\s*(?:import|export)\b/mu.test(changedText) ||
      // Any element or fragment form, including `<>` fragments the old tag pattern could not see.
      /<\/?(?:[A-Za-z_$][\w$.:-]*)?(?:\s|>|\/)/u.test(changedText) ||
      /\{[\s\S]*\}/u.test(changedText)
    ) {
      return "EXECUTABLE";
    }
    // Prose is inert only when it fits the positive prose grammar. Regex silence is ambiguous.
    return isPositivelyPlainProse(lines) && !hybridStructuralSyntax.test(changedText)
      ? "INERT"
      : "AMBIGUOUS";
  }
  if (/\.svg$/iu.test(file)) {
    if (
      // Namespace-qualified forms (`<svg:script>`) and any event-bearing attribute, including the
      // animation `onbegin`/`onend` family, count as recognized executable syntax.
      /<\s*(?:[A-Za-z_][\w.-]*:)?script\b/iu.test(changedText) ||
      /\bon[A-Za-z_:][\w:.-]*\s*=/iu.test(changedText) ||
      /\b(?:href|src|xlink:href)\s*=\s*["']?\s*(?:javascript|data):/iu.test(changedText) ||
      /<\s*(?:[A-Za-z_][\w.-]*:)?(?:foreignObject|handler|animate|set|use)\b/iu.test(changedText)
    ) {
      return "EXECUTABLE";
    }
    // An SVG document is structural by nature: unrecognized markup is ambiguous, never inert.
    return hybridStructuralSyntax.test(changedText) ? "AMBIGUOUS" : "INERT";
  }
  return "AMBIGUOUS";
};

/** Comment recognition is language-aware; see isProvenCommentLine in local-code-semantics. */

/**
 * Credential-shaped identifier naming. This is a NAMING convention test, not an API catalogue —
 * it is the one lexical element that genuinely transfers across every language, because humans
 * name secrets the same way regardless of syntax.
 *
 * The prefix and suffix are both optional so that an identifier which IS the bare term (`token`,
 * `session_key`) matches as readily as a decorated one (`userSessionKey`). Requiring a prefix
 * character was a real miss: the most obvious names are the undecorated ones.
 */
const credentialName =
  /\b[A-Za-z_][A-Za-z0-9_]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|auth[_-]?token|session[_-]?key|passphrase)[A-Za-z0-9_]*\b|\b(?:password|passwd|pwd|secret|token|apikey|credential|session[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?token|passphrase)\b/iu;

/**
 * Reading from the environment or a config store. Universal shapes, not per-language APIs: an
 * accessor into an env namespace (`.`, `::` and `->` all appear across the languages that matter),
 * a get-style call, or a shell/Perl-style expansion.
 */
const environmentRead =
  /\b(?:env|environ|environment|getenv|ENV)\b\s*(?:(?:\.|::|->)\s*\w+\s*)?[([{]|\bgetenv\b|\$\{?[A-Z][A-Z0-9_]{2,}\}?|\bprocess\s*\.\s*env\b|\bconfig\s*(?:(?:\.|::|->)\s*\w+\s*)?[([]/u;

/**
 * Output/exposure sinks. Print, log, write, and error-propagation shapes are one of the most
 * stable cross-language constructs there is. Logging appears both as a member call (`logger.warn`,
 * `console.error`) and as a bare function (`error_log`, `syslog`, `NSLog`), so both forms count.
 */
const outputSink =
  /\b(?:print(?:ln|f|_r)?|log(?:ger)?\s*(?:\.|::|->)\s*\w+|console\s*\.\s*\w+|echo|puts|warn|write(?:line)?|fmt\s*\.\s*\w*[Pp]rint\w*|panic|fatal|raise|throw|std(?:out|err))\b|\b\w*log\w*\s*\(/iu;

/**
 * Concealed-input shapes: a call whose NAME encodes that it hides what the user types. Matching on
 * the concealment concept rather than on any one runtime's function keeps it general.
 */
const concealedInputShape =
  /\b(?:read[_\s]*password|readpassword|getpass|get[_\s]*pass|ask[_\s]*(?:pass|secret)|prompt[_\s]*(?:for[_\s]*)?(?:password|secret)|hidden[_\s]*input|hide[_\s]*input|no[_\s]*echo|noecho|secure[_\s]*(?:string|input|entry)|mask(?:ed)?[_\s]*input)\b/iu;

/** Security-domain subjects, separated from HOW a decision is expressed. */
const authorizationSubject =
  /\b(?=[A-Za-z_$][\w$]*\b)(?=[\w$]*(?:role|owner|scope|permission|policy|entitlement|principal|tenant|access|authoriz|admin|member))[A-Za-z_$][\w$]*\b/iu;

/**
 * A bounded authorization decision is a security-domain subject used in a syntactic boolean
 * context. This is deliberately not a verb/method catalogue: membership APIs, equality checks,
 * policy objects and permission-set calls all reduce to the same representation once their result
 * controls a branch or is explicitly typed/compared as boolean.
 */
const authorizationDecision = (statement: string, localContext: string): boolean => {
  if (!authorizationSubject.test(statement)) return false;
  const booleanContext =
    /\b(?:if|while|unless)\s*\(/iu.test(statement) ||
    /(?:===?|!==?|<=|>=|<|>)/u.test(statement) ||
    /(?::|\bas\s+)\s*(?:bool|boolean)\b/iu.test(statement) ||
    /\b(?:bool|boolean)\s+[A-Za-z_$][\w$]*\s*=/iu.test(statement) ||
    (/\breturn\b/iu.test(statement) && /\b(?:bool|boolean)\b[^{}]*\{/iu.test(localContext));
  return booleanContext;
};

/** A binding or a call argument — the two shapes in which a named value participates in behaviour. */
const participatesInBehaviour = (line: string): boolean =>
  /[:=]/u.test(line) || /\w\s*\(/u.test(line);

const completelyCoveredConcealedOrigin = (
  statement: string,
  declarationLanguage: DeclarationLanguage,
): boolean => {
  const binding = extractSimpleLocalBinding(statement);
  if (binding === null) return false;
  const directCall = directLocalCallExpression(binding.expression);
  return (
    directCall !== null &&
    concealedInputShape.test(directCall.callee) &&
    directSourceCallArgumentsCovered(directCall, declarationLanguage)
  );
};

/**
 * Whether the COMPLETE authorization-decision unit was analyzed.
 *
 * The previous form was `extractLocalCallSites(statement).every(...)`, which returns true for the
 * empty set — so a statement with no call sites at all minted FULL coverage from ZERO positive
 * observations (P1.1). `role === 'admin' && (audit = 1)` was "fully covered" because neither region
 * was a call.
 *
 * FULL now requires positive proof that the whole decision region is inside the bounded contract:
 * the entire condition must be a proven effect-free scalar expression, and any call sites present
 * must be control forms only. This build does not evaluate authorization CORRECTNESS in any case —
 * no capability establishes AUTHORIZATION_BEHAVIOR — but the coverage claim itself must be honest,
 * because coverage feeds changed-scope accounting independently of concern resolution.
 */
const completelyCoveredAuthorizationDecision = (statement: string): boolean => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const callSitesAreControlOnly = extractLocalCallSites(normalized).every((site) =>
    /^(?:if|while|unless)$/iu.test(site.callee.trim()),
  );
  if (!callSitesAreControlOnly) return false;
  const control = normalized.match(/^\s*(?:if|while|unless)\s*\(([\s\S]*)\)\s*\{?\s*$/u)?.[1];
  if (control !== undefined) return isProvenEffectFreeScalarExpression(control);
  const binding = extractSimpleLocalBinding(normalized);
  return binding !== null && isProvenEffectFreeScalarExpression(binding.expression);
};

const discoveryCoverageFor = (
  file: string,
  languageClass: LanguageClass,
  uninspectable: boolean,
): AnalysisCoverage => {
  if (uninspectable) return "UNSUPPORTED";
  if (/\.json$/iu.test(file) || languageClass === "CONFIG_WORKFLOW" || /\.sql$/iu.test(file)) {
    return "UNSUPPORTED";
  }
  if (languageClass === "SHELL" || !/\.[^/]+$/u.test(file)) return "PARTIAL";
  return "FULL";
};

const coverageRank: Record<AnalysisCoverage, number> = {
  NOT_APPLICABLE: 3,
  FULL: 2,
  PARTIAL: 1,
  UNSUPPORTED: 0,
};

interface ChangedScopeUnit {
  key: string;
  file: string;
  changeKind: "ADDED" | "REMOVED" | "UNINSPECTABLE";
  languageClass: LanguageClass;
  fileCoverage: AnalysisCoverage;
  declarationLanguage: DeclarationLanguage;
  statement: string;
  classification: BoundedDiscoveryStatementClass | null;
}

const unitKey = (file: string, changeKind: ChangedScopeUnit["changeKind"], index: number): string =>
  `${file}::${changeKind}::${index}`;

/**
 * Filters out only text POSITIVELY proven to be a comment in this file's own language, then splits
 * the remainder into bounded statements.
 *
 * Ordering matters and is the RC3a repair. Comment recognition happens per RAW LINE, BEFORE
 * continuation joining, so a comment-shaped prefix can never be glued to a following executable
 * statement and take it out of scope with it. Whatever survives is real inspectable material: if
 * segmentation cannot produce a clean statement, the text still becomes a unit rather than
 * disappearing.
 */
type LexicalState =
  | { kind: "CODE" }
  | { kind: "UNKNOWN" }
  | { kind: "BLOCK_COMMENT"; close: string }
  | { kind: "JS_TEMPLATE" }
  | { kind: "PYTHON_TRIPLE"; close: "'''" | '\"\"\"' }
  | { kind: "SHELL_HEREDOC"; close: string }
  | { kind: "YAML_BLOCK"; indentation: number }
  | { kind: "LUA_LONG_COMMENT"; close: string };

const unescapedCount = (line: string, token: string): number => {
  let count = 0;
  for (let index = 0; index <= line.length - token.length; index += 1) {
    if (line.slice(index, index + token.length) !== token) continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
    index += token.length - 1;
  }
  return count;
};

const classifyLexicalLine = (
  line: string,
  state: LexicalState,
  language: DeclarationLanguage,
  file: string,
): { state: LexicalState; provenIrrelevant: boolean } => {
  const trimmed = line.trim();
  if (state.kind === "UNKNOWN") return { state, provenIrrelevant: false };
  if (state.kind === "JS_TEMPLATE") {
    return {
      state: unescapedCount(line, "`") % 2 === 1 ? { kind: "CODE" } : state,
      provenIrrelevant: false,
    };
  }
  if (state.kind === "PYTHON_TRIPLE") {
    return {
      state: line.includes(state.close) ? { kind: "CODE" } : state,
      provenIrrelevant: false,
    };
  }
  if (state.kind === "SHELL_HEREDOC") {
    return {
      state: trimmed === state.close ? { kind: "CODE" } : state,
      provenIrrelevant: false,
    };
  }
  if (state.kind === "YAML_BLOCK") {
    if (trimmed === "") return { state, provenIrrelevant: false };
    const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
    if (indentation > state.indentation) return { state, provenIrrelevant: false };
    return classifyLexicalLine(line, { kind: "CODE" }, language, file);
  }
  if (state.kind === "BLOCK_COMMENT" || state.kind === "LUA_LONG_COMMENT") {
    const closeIndex = line.indexOf(state.close);
    if (closeIndex < 0) return { state, provenIrrelevant: true };
    return {
      state: { kind: "CODE" },
      provenIrrelevant: line.slice(closeIndex + state.close.length).trim() === "",
    };
  }

  if (trimmed === "") return { state, provenIrrelevant: true };
  if (/\.lua$/iu.test(file)) {
    const long = trimmed.match(/^--\[(=*)\[/u);
    if (long?.[1] !== undefined) {
      const close = `]${long[1]}]`;
      const closeIndex = trimmed.indexOf(close, long[0].length);
      if (closeIndex < 0) {
        return { state: { kind: "LUA_LONG_COMMENT", close }, provenIrrelevant: true };
      }
      return {
        state,
        provenIrrelevant: trimmed.slice(closeIndex + close.length).trim() === "",
      };
    }
  }
  if (isProvenCommentLine(line, language, file)) {
    const syntax = trimmed.startsWith("/*") && !trimmed.includes("*/");
    return {
      state: syntax ? { kind: "BLOCK_COMMENT", close: "*/" } : state,
      provenIrrelevant: true,
    };
  }

  if (language === "TS_JS" && unescapedCount(line, "`") % 2 === 1) {
    return { state: { kind: "JS_TEMPLATE" }, provenIrrelevant: false };
  }
  if (language === "PYTHON") {
    for (const close of ["'''", '"""'] as const) {
      if (unescapedCount(line, close) % 2 === 1) {
        return { state: { kind: "PYTHON_TRIPLE", close }, provenIrrelevant: false };
      }
    }
  }
  if (/\.(?:sh|bash|zsh|fish)$/iu.test(file)) {
    const heredoc = line.match(/<<-?\s*["']?([A-Za-z_][\w]*)["']?/u)?.[1];
    if (heredoc !== undefined) {
      return { state: { kind: "SHELL_HEREDOC", close: heredoc }, provenIrrelevant: false };
    }
  }
  if (/\.ya?ml$/iu.test(file)) {
    const header = line.match(/^(\s*)[^#\r\n][^:\r\n]*:\s*[|>][+-]?\d*\s*(?:#.*)?$/u);
    if (header?.[1] !== undefined) {
      return {
        state: { kind: "YAML_BLOCK", indentation: header[1].length },
        provenIrrelevant: false,
      };
    }
  }
  return { state, provenIrrelevant: false };
};

/** Changed-line indices whose lexical context positively proves behavioral irrelevance. */
const provenIrrelevantLineIndices = (
  entry: FilePatch,
  side: "ADDED" | "REMOVED",
  language: DeclarationLanguage,
): Set<number> => {
  const proven = new Set<number>();
  for (const hunk of entry.hunks ?? []) {
    const startsAtFileBoundary = side === "ADDED" ? hunk.newStart <= 1 : hunk.oldStart <= 1;
    let state: LexicalState = startsAtFileBoundary ? { kind: "CODE" } : { kind: "UNKNOWN" };
    for (const line of hunk.lines) {
      if (line.kind !== "CONTEXT" && line.kind !== side) continue;
      const result = classifyLexicalLine(line.text, state, language, entry.file);
      state = result.state;
      if (line.kind === side && line.changedIndex !== undefined && result.provenIrrelevant) {
        proven.add(line.changedIndex);
      }
    }
  }
  return proven;
};

const relevantLocalStatements = (lines: string[], irrelevant: ReadonlySet<number>): string[] =>
  splitLocalStatements(lines.filter((_line, index) => !irrelevant.has(index))).filter(
    (line) => line.trim() !== "",
  );

/**
 * Discovers material concerns from a diff's added lines, independent of file path naming and
 * independent of whether any analyzer models the language.
 */
export const discoverConcerns = (patch: string): ConcernDiscoveryResult => {
  const concerns: DiscoveredConcern[] = [];
  const touched = new Set<LanguageClass>();
  const evidence: string[] = [];
  const seen = new Set<string>();
  const scopeUnits: ChangedScopeUnit[] = [];
  const scopeUnitsByFile = new Map<string, ChangedScopeUnit[]>();
  const concernAttributedUnitKeys = new Set<string>();
  const concernCoverageByUnitKey = new Map<string, "PARTIAL" | "FULL">();
  const rawDispositionByIdentity = new Map<string, RawScopeAtomDisposition>();
  let readabilityCoverage: AnalysisCoverage = "NOT_APPLICABLE";
  const boundedClasses = new Map<string, number>();

  const attribute = (keys: string[], coverage: "PARTIAL" | "FULL"): void => {
    for (const key of keys) {
      concernAttributedUnitKeys.add(key);
      const existing = concernCoverageByUnitKey.get(key);
      // Unit coverage is conjunctive: absent region-aware evidence, any PARTIAL attribution means
      // some expression region remains unaccounted. Registration order and enum strength cannot
      // turn that unit FULL.
      concernCoverageByUnitKey.set(
        key,
        existing === "PARTIAL" || coverage === "PARTIAL" ? "PARTIAL" : "FULL",
      );
    }
  };

  const raise = (
    concern: ConcernType,
    file: string,
    languageClass: LanguageClass,
    shape: string,
    attributedUnitKeys: string[] = [],
    unitCoverage: "PARTIAL" | "FULL" = "PARTIAL",
    obligationAtomIdentities: string[] = attributedUnitKeys,
  ): void => {
    attribute(attributedUnitKeys, unitCoverage);
    const key = `${concern}::${file}`;
    if (seen.has(key)) {
      const existing = concerns.find((item) => `${item.concern}::${item.file}` === key);
      if (existing) {
        existing.obligationAtomIdentities = [
          ...new Set([...existing.obligationAtomIdentities, ...obligationAtomIdentities]),
        ];
      }
      return;
    }
    seen.add(key);
    concerns.push({
      concern,
      file,
      languageClass,
      evidence: shape,
      obligationAtomIdentities: [...new Set(obligationAtomIdentities)],
    });
  };

  const rawLineIdentity = (
    file: string,
    kind: "ADDED" | "REMOVED",
    index: number,
    filePatchIndex: number,
  ): string => `${file}::PATCH_${filePatchIndex}::RAW_${kind}::${index}`;
  const setRawDisposition = (disposition: RawScopeAtomDisposition): void => {
    rawDispositionByIdentity.set(disposition.atomIdentity, disposition);
  };
  const parsedPatches = parseFilePatches(patch);
  if (parsedPatches.length === 0 && patch.trim() !== "") {
    const atomIdentity = "<unparsed-patch>::RAW::0";
    setRawDisposition({
      atomIdentity,
      file: "<unparsed-patch>",
      atomKind: "UNPARSED_PATCH",
      disposition: "UNSUPPORTED",
      reason: "non-empty candidate patch produced no attributable file material",
    });
    scopeUnits.push({
      key: unitKey("<unparsed-patch>", "UNINSPECTABLE", 0),
      file: "<unparsed-patch>",
      changeKind: "UNINSPECTABLE",
      languageClass: "UNMODELLED",
      fileCoverage: "UNSUPPORTED",
      declarationLanguage: "OTHER",
      statement: "[non-empty unparsed candidate patch]",
      classification: null,
    });
    touched.add("UNMODELLED");
    readabilityCoverage = "UNSUPPORTED";
  }

  for (const [filePatchIndex, entry] of parsedPatches.entries()) {
    const languageClass = languageClassOf(entry.file);
    const declarationLanguage = declarationLanguageOf(entry.file);
    const uninspectable = entry.binary || (entry.uninspectableReasons?.length ?? 0) > 0;
    const pathFiltered = nonProductionPath.test(entry.file);
    const isHybrid = inspectableExecutableHybridFile.test(entry.file);
    const hybridClass = isHybrid
      ? classifyHybridContent(entry.file, [...entry.addedLines, ...entry.removedLines])
      : "INERT";
    // Detector silence is not absence. Only content POSITIVELY recognized as inert may be excluded;
    // recognized-executable and ambiguous hybrid material both stay in scope (RC3b).
    const executableHybrid = isHybrid && hybridClass !== "INERT";
    for (const [index] of entry.addedLines.entries()) {
      const atomIdentity = rawLineIdentity(entry.file, "ADDED", index, filePatchIndex);
      setRawDisposition({
        atomIdentity,
        file: entry.file,
        atomKind: "ADDED_TEXT",
        disposition: "UNCLASSIFIED_RESIDUAL",
        reason: "changed text has not yet received a terminal analyzer disposition",
      });
    }
    for (const [index] of entry.removedLines.entries()) {
      const atomIdentity = rawLineIdentity(entry.file, "REMOVED", index, filePatchIndex);
      setRawDisposition({
        atomIdentity,
        file: entry.file,
        atomKind: "REMOVED_TEXT",
        disposition: "UNCLASSIFIED_RESIDUAL",
        reason: "changed text has not yet received a terminal analyzer disposition",
      });
    }
    for (const [index, reason] of (entry.uninspectableReasons ?? []).entries()) {
      const atomIdentity = `${entry.file}::PATCH_${filePatchIndex}::GIT_METADATA::${index}:${reason}`;
      setRawDisposition({
        atomIdentity,
        file: entry.file,
        atomKind: "GIT_METADATA",
        disposition: "UNSUPPORTED",
        reason: `Git metadata ${reason} has no behavior-complete analyzer`,
      });
    }
    if (
      entry.addedLines.length === 0 &&
      entry.removedLines.length === 0 &&
      (entry.uninspectableReasons?.length ?? 0) === 0
    ) {
      setRawDisposition({
        atomIdentity: `${entry.file}::PATCH_${filePatchIndex}::GIT_METADATA::EMPTY_FILE_PATCH`,
        file: entry.file,
        atomKind: "GIT_METADATA",
        disposition: "UNSUPPORTED",
        reason: "a file patch was present without changed text or classified metadata",
      });
    }
    const positivelyInertText =
      (isHybrid && hybridClass === "INERT") ||
      (!isHybrid &&
        proseCapableFile.test(entry.file) &&
        isPositivelyPlainProse([...entry.addedLines, ...entry.removedLines]));
    if (!uninspectable && !pathFiltered && positivelyInertText) {
      for (const [index] of entry.addedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "ADDED", index, filePatchIndex),
          file: entry.file,
          atomKind: "ADDED_TEXT",
          disposition: "PROVEN_IRRELEVANT",
          reason: isHybrid
            ? "hybrid content matched the positive plain-prose grammar"
            : "text matched the positive plain-prose grammar",
        });
      }
      for (const [index] of entry.removedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "REMOVED", index, filePatchIndex),
          file: entry.file,
          atomKind: "REMOVED_TEXT",
          disposition: "PROVEN_IRRELEVANT",
          reason: isHybrid
            ? "hybrid content matched the positive plain-prose grammar"
            : "text matched the positive plain-prose grammar",
        });
      }
      continue;
    }
    if (pathFiltered || uninspectable) {
      for (const [index] of entry.addedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "ADDED", index, filePatchIndex),
          file: entry.file,
          atomKind: "ADDED_TEXT",
          disposition: "UNSUPPORTED",
          reason: pathFiltered
            ? "dependency-path text is outside trusted semantic inspection"
            : "text belongs to an uninspectable Git change",
        });
      }
      for (const [index] of entry.removedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "REMOVED", index, filePatchIndex),
          file: entry.file,
          atomKind: "REMOVED_TEXT",
          disposition: "UNSUPPORTED",
          reason: pathFiltered
            ? "dependency-path text is outside trusted semantic inspection"
            : "text belongs to an uninspectable Git change",
        });
      }
      const opaqueUnit: ChangedScopeUnit = {
        key: unitKey(entry.file, "UNINSPECTABLE", 0),
        file: entry.file,
        changeKind: "UNINSPECTABLE",
        languageClass,
        fileCoverage: "UNSUPPORTED",
        declarationLanguage,
        statement: pathFiltered
          ? "[changed dependency-path material excluded from semantic inspection]"
          : "[uninspectable changed material]",
        classification: null,
      };
      scopeUnits.push(opaqueUnit);
      scopeUnitsByFile.set(entry.file, [opaqueUnit]);
      touched.add(languageClass);
      readabilityCoverage = "UNSUPPORTED";
      continue;
    }
    const opaqueNonSourceMaterial =
      (!isHybrid && proseCapableFile.test(entry.file) && !positivelyInertText) ||
      unsupportedDataFile.test(entry.file);
    if (opaqueNonSourceMaterial) {
      for (const [index] of entry.addedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "ADDED", index, filePatchIndex),
          file: entry.file,
          atomKind: "ADDED_TEXT",
          disposition: "UNSUPPORTED",
          reason: "non-source text did not match the positive prose grammar",
        });
      }
      for (const [index] of entry.removedLines.entries()) {
        setRawDisposition({
          atomIdentity: rawLineIdentity(entry.file, "REMOVED", index, filePatchIndex),
          file: entry.file,
          atomKind: "REMOVED_TEXT",
          disposition: "UNSUPPORTED",
          reason: "non-source text did not match the positive prose grammar",
        });
      }
      const opaqueTextUnit: ChangedScopeUnit = {
        key: unitKey(entry.file, "UNINSPECTABLE", 0),
        file: entry.file,
        changeKind: "UNINSPECTABLE",
        languageClass,
        fileCoverage: "UNSUPPORTED",
        declarationLanguage,
        statement: "[non-source material outside the positive prose classifier]",
        classification: null,
      };
      scopeUnits.push(opaqueTextUnit);
      scopeUnitsByFile.set(entry.file, [opaqueTextUnit]);
      touched.add(languageClass);
      readabilityCoverage = "UNSUPPORTED";
      continue;
    }
    // Recognizing embedded executable syntax does not establish the hybrid format's execution
    // semantics. Keep its inspectable statements for positive routing, but force adequacy to
    // UNSUPPORTED until a format-aware capability exists.
    const unsupportedFileClass =
      executableHybrid ||
      unsupportedDataFile.test(entry.file) ||
      (proseCapableFile.test(entry.file) && !positivelyInertText);
    const fileCoverage = unsupportedFileClass
      ? "UNSUPPORTED"
      : discoveryCoverageFor(entry.file, languageClass, false);
    if (coverageRank[fileCoverage] < coverageRank[readabilityCoverage]) {
      readabilityCoverage = fileCoverage;
    }
    const irrelevantAdded = provenIrrelevantLineIndices(entry, "ADDED", declarationLanguage);
    const irrelevantRemoved = provenIrrelevantLineIndices(entry, "REMOVED", declarationLanguage);
    const lines = relevantLocalStatements(entry.addedLines, irrelevantAdded);
    const removedLines = relevantLocalStatements(entry.removedLines, irrelevantRemoved);
    for (const [index] of entry.addedLines.entries()) {
      setRawDisposition({
        atomIdentity: rawLineIdentity(entry.file, "ADDED", index, filePatchIndex),
        file: entry.file,
        atomKind: "ADDED_TEXT",
        disposition: irrelevantAdded.has(index)
          ? "PROVEN_IRRELEVANT"
          : lines.length > 0
            ? "ANALYZED"
            : unsupportedFileClass
              ? "UNSUPPORTED"
              : "UNCLASSIFIED_RESIDUAL",
        reason: irrelevantAdded.has(index)
          ? "lexical state positively proves an ordinary non-directive comment or blank line"
          : lines.length > 0
            ? "changed text was retained in bounded statement analysis"
            : unsupportedFileClass
              ? "no behavior-complete analyzer exists for this file material"
              : "statement segmentation did not account for changed text",
      });
    }
    for (const [index] of entry.removedLines.entries()) {
      setRawDisposition({
        atomIdentity: rawLineIdentity(entry.file, "REMOVED", index, filePatchIndex),
        file: entry.file,
        atomKind: "REMOVED_TEXT",
        disposition: irrelevantRemoved.has(index)
          ? "PROVEN_IRRELEVANT"
          : removedLines.length > 0
            ? "ANALYZED"
            : unsupportedFileClass
              ? "UNSUPPORTED"
              : "UNCLASSIFIED_RESIDUAL",
        reason: irrelevantRemoved.has(index)
          ? "lexical state positively proves an ordinary non-directive comment or blank line"
          : removedLines.length > 0
            ? "changed text was retained in bounded statement analysis"
            : unsupportedFileClass
              ? "no behavior-complete analyzer exists for this file material"
              : "statement segmentation did not account for changed text",
      });
    }
    if (lines.length === 0 && removedLines.length === 0) {
      // An executable-capable hybrid whose content is recognized-executable or ambiguous must not
      // become EMPTY_EXECUTABLE_SCOPE just because bounded statement segmentation produced nothing
      // it understands. The inspectable material stays as one explicit unsupported unit (RC3b).
      if (
        unsupportedFileClass &&
        [...entry.addedLines, ...entry.removedLines].some((line) => line.trim() !== "")
      ) {
        const hybridUnit: ChangedScopeUnit = {
          key: unitKey(entry.file, "UNINSPECTABLE", 0),
          file: entry.file,
          changeKind: "UNINSPECTABLE",
          languageClass,
          fileCoverage: "UNSUPPORTED",
          declarationLanguage,
          statement: `[unsupported changed material outside bounded statement analysis]`,
          classification: null,
        };
        scopeUnits.push(hybridUnit);
        scopeUnitsByFile.set(entry.file, [hybridUnit]);
        touched.add(languageClass);
        readabilityCoverage = "UNSUPPORTED";
      }
      continue;
    }
    const fileUnits = lines.map<ChangedScopeUnit>((statement, index) => ({
      key: unitKey(entry.file, "ADDED", index),
      file: entry.file,
      changeKind: "ADDED",
      languageClass,
      fileCoverage,
      declarationLanguage,
      statement,
      classification: classifyBoundedDiscoveryStatement(statement, declarationLanguage),
    }));
    const removedUnits = removedLines.map<ChangedScopeUnit>((statement, index) => ({
      key: unitKey(entry.file, "REMOVED", index),
      file: entry.file,
      changeKind: "REMOVED",
      languageClass,
      fileCoverage,
      declarationLanguage,
      statement,
      classification: classifyBoundedDiscoveryStatement(statement, declarationLanguage),
    }));
    scopeUnits.push(...fileUnits, ...removedUnits);
    scopeUnitsByFile.set(entry.file, fileUnits);
    for (const unit of [...fileUnits, ...removedUnits]) {
      if (
        unit.classification !== null &&
        establishesPromotionAbsence(
          unit.statement,
          unit.classification,
          unit.changeKind,
          unit.declarationLanguage,
        )
      ) {
        boundedClasses.set(unit.classification, (boundedClasses.get(unit.classification) ?? 0) + 1);
      }
    }
    touched.add(languageClass);
    for (const [rawIndex, rawLine] of entry.addedLines.entries()) {
      const atomIdentity = rawLineIdentity(entry.file, "ADDED", rawIndex, filePatchIndex);
      if (rawDispositionByIdentity.get(atomIdentity)?.disposition !== "ANALYZED") continue;
      for (const assignment of credentialLiteralAssignments(
        rawLine,
        entry.file,
        rawIndex,
        filePatchIndex,
      )) {
        const currentUnit = fileUnits.find((unit) => unit.statement.includes(rawLine.trim()));
        raise(
          "SECURITY.CREDENTIAL_LITERAL",
          entry.file,
          languageClass,
          `credential-shaped binding ${assignment.name} receives a quoted value in added code (value omitted from evidence)`,
          currentUnit ? [currentUnit.key] : [],
          isFixedDataDeclaration(rawLine, declarationLanguage) ? "FULL" : "PARTIAL",
          [assignment.atomIdentity],
        );
      }
    }
    if (lines.length === 0) continue;

    // A short sliding window: a source and its sink are frequently adjacent but rarely on the same
    // line in real code. Bounded at 3 lines so this stays a local-shape test, not a flow analysis
    // — MAF does not claim to do cross-file (or even cross-function) data flow.
    const window = 3;
    const locallySensitiveBindings = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const currentUnit = fileUnits[index];
      const nearby = lines.slice(index, index + window).join("\n");
      const localContext = lines.slice(Math.max(0, index - 1), index + window).join("\n");

      for (const name of locallySensitiveBindings) {
        if (currentUnit && identifierOccursIn(line, name)) {
          // "All uses of name are known" and "the whole statement is accounted" are separate.
          // Only an exact whole-statement local observation receives FULL concern coverage.
          const observationCoverage = isFullyCoveredLocalObservation(line, name)
            ? "FULL"
            : "PARTIAL";
          attribute([currentUnit.key], observationCoverage);
          if (
            observationCoverage === "FULL" &&
            /^\s*(?:if|while)\s*\(/u.test(line) &&
            fileUnits[index + 1]?.statement.trim() === "}"
          ) {
            attribute([fileUnits[index + 1]?.key ?? ""].filter(Boolean), "FULL");
          }
          const alias = extractSimpleLocalBinding(line);
          // Match the flow analyzer's deliberately narrow alias contract. An expression that only
          // mentions the value is not thereby a proven alias.
          if (alias !== null && alias.expression === name) {
            locallySensitiveBindings.add(alias.name);
          }
        }
      }

      if (concealedInputShape.test(line)) {
        raise(
          "SECURITY.SENSITIVE_INPUT_FLOW",
          entry.file,
          languageClass,
          `concealed-input shape in added code: ${line.trim().slice(0, 120)}`,
          currentUnit ? [currentUnit.key] : [],
          completelyCoveredConcealedOrigin(line, declarationLanguage) ? "FULL" : "PARTIAL",
        );
        const binding = extractSimpleLocalBinding(line);
        if (binding !== null) locallySensitiveBindings.add(binding.name);
      }
      if (credentialName.test(line) && participatesInBehaviour(line)) {
        // A credential-shaped name that then reaches an output sink nearby is the flow question.
        if (outputSink.test(nearby)) {
          raise(
            "SECURITY.SENSITIVE_INPUT_FLOW",
            entry.file,
            languageClass,
            `credential-shaped identifier reaching an output/propagation sink within ${window} added lines: ${line.trim().slice(0, 120)}`,
            fileUnits
              .slice(index, index + window)
              .filter((unit, offset) => offset === 0 || outputSink.test(unit.statement))
              .map((unit) => unit.key),
          );
        }
      }
      if (environmentRead.test(line)) {
        const secretShaped = credentialName.test(line) || credentialName.test(nearby);
        if (secretShaped || outputSink.test(nearby)) {
          raise(
            "SECURITY.ENV_SECRET_EXPOSURE",
            entry.file,
            languageClass,
            `environment/config read${outputSink.test(nearby) ? " reaching an output sink" : " of a credential-shaped name"}: ${line.trim().slice(0, 120)}`,
            fileUnits
              .slice(index, index + window)
              .filter((unit, offset) => offset === 0 || outputSink.test(unit.statement))
              .map((unit) => unit.key),
          );
          const binding = extractSimpleLocalBinding(line);
          if (binding !== null) locallySensitiveBindings.add(binding.name);
        }
      }
      if (authorizationDecision(line, localContext)) {
        raise(
          "SECURITY.AUTHORIZATION_BEHAVIOR",
          entry.file,
          languageClass,
          `security-domain value participates in a boolean decision context: ${line.trim().slice(0, 120)}`,
          currentUnit ? [currentUnit.key] : [],
          completelyCoveredAuthorizationDecision(line) ? "FULL" : "PARTIAL",
        );
      }
    }
    const commandBoundary = dynamicCommandBoundary(lines);
    if (commandBoundary !== null) {
      raise(
        "SECURITY.SUBPROCESS_EXECUTION",
        entry.file,
        languageClass,
        `invoked command/process boundary receives dynamic argument data: ${commandBoundary.trim().slice(0, 120)}`,
        fileUnits.filter((unit) => unit.statement === commandBoundary).map((unit) => unit.key),
      );
    } else {
      const unclassifiedDynamicCalls = dynamicArgumentCallSites(lines);
      if (unclassifiedDynamicCalls.length > 0) {
        evidence.push(
          `${entry.file}: ${unclassifiedDynamicCalls.length} dynamic-argument call(s) were not classified as command/process boundaries; execution-boundary silence is not absence`,
        );
      }
    }
  }

  // Reuse the existing bounded semantic source→sink pairing as an additional concern-discovery
  // source. This keeps its result typed: it raises SENSITIVE_INPUT_FLOW, after which only evidence
  // addressed to that exact concern may resolve it. The broad Security projection is never read.
  for (const pair of deriveSemanticSensitivity(patch).exposurePairs) {
    const sourceToken = pair.source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const attributed = (scopeUnitsByFile.get(pair.file) ?? [])
      .filter((unit) => new RegExp(`(?<![\\w$])${sourceToken}(?![\\w$])`, "u").test(unit.statement))
      .map((unit) => unit.key);
    raise(
      "SECURITY.SENSITIVE_INPUT_FLOW",
      pair.file,
      languageClassOf(pair.file),
      `bounded semantic source→sink pairing in added code: sensitive binding reaches ${pair.sink}`,
      attributed,
    );
  }

  const touchedClasses = [...touched];
  const syntaxClassifiedUnits = scopeUnits.filter((unit) => unit.classification !== null);
  const promotionBoundedUnits = scopeUnits.filter(
    (unit) =>
      unit.classification !== null &&
      establishesPromotionAbsence(
        unit.statement,
        unit.classification,
        unit.changeKind,
        unit.declarationLanguage,
      ),
  );
  const fixedArgumentInvocationUnits = scopeUnits.filter(
    (unit) => unit.classification === "FIXED_ARGUMENT_INVOCATION",
  ).length;
  let unsupportedUnits = 0;
  let unclassifiedRemainderUnits = 0;
  const residualUnitIdentities: string[] = [];
  for (const unit of scopeUnits) {
    const concernCovered = concernCoverageByUnitKey.get(unit.key) === "FULL";
    const promotionAbsenceEstablished =
      unit.classification !== null &&
      establishesPromotionAbsence(
        unit.statement,
        unit.classification,
        unit.changeKind,
        unit.declarationLanguage,
      );
    // Config/workflow or uninspectable material is unsupported even if a lexical shape happened
    // to match. For unmodelled source languages, an exact bounded class or concrete concern may
    // account for its local statement; otherwise the language gap is explicit unsupported scope.
    if (unit.fileCoverage === "UNSUPPORTED") {
      unsupportedUnits += 1;
      residualUnitIdentities.push(unit.key);
    } else if (!concernCovered && !promotionAbsenceEstablished) {
      if (unit.languageClass === "UNMODELLED" || unit.languageClass === "BOUNDED_COMPILED") {
        unsupportedUnits += 1;
      } else unclassifiedRemainderUnits += 1;
      residualUnitIdentities.push(unit.key);
    }
  }
  const rawAtomDispositions = [...rawDispositionByIdentity.values()];
  const analyzedRawAtoms = rawAtomDispositions.filter(
    (atom) => atom.disposition === "ANALYZED",
  ).length;
  const unsupportedRawAtoms = rawAtomDispositions.filter(
    (atom) => atom.disposition === "UNSUPPORTED",
  ).length;
  const unclassifiedRawAtoms = rawAtomDispositions.filter(
    (atom) => atom.disposition === "UNCLASSIFIED_RESIDUAL",
  ).length;
  const provenIrrelevantRawAtoms = rawAtomDispositions.filter(
    (atom) => atom.disposition === "PROVEN_IRRELEVANT",
  ).length;
  const emptyScopeProven =
    scopeUnits.length === 0 &&
    (rawAtomDispositions.length === 0 || provenIrrelevantRawAtoms === rawAtomDispositions.length);
  const complete =
    unsupportedUnits === 0 &&
    unclassifiedRemainderUnits === 0 &&
    unsupportedRawAtoms === 0 &&
    unclassifiedRawAtoms === 0 &&
    (scopeUnits.length > 0 || emptyScopeProven);
  const concernCoveredUnits = scopeUnits.filter(
    (unit) => concernCoverageByUnitKey.get(unit.key) === "FULL",
  ).length;
  const partiallyConcernCoveredUnits = scopeUnits.filter(
    (unit) => concernCoverageByUnitKey.get(unit.key) === "PARTIAL",
  ).length;
  const scopeAccounting: DiscoveryScopeAccounting = {
    unit: "CHANGED_LOCAL_STATEMENT",
    totalRelevantUnits: scopeUnits.length,
    concernAttributedUnits: concernAttributedUnitKeys.size,
    concernCoveredUnits,
    partiallyConcernCoveredUnits,
    syntaxClassifiedUnits: syntaxClassifiedUnits.length,
    boundedClassifiedUnits: promotionBoundedUnits.length,
    promotionAbsenceEstablishedUnits: promotionBoundedUnits.length,
    fixedArgumentInvocationUnits,
    unsupportedUnits,
    unclassifiedRemainderUnits,
    rawChangedAtoms: rawAtomDispositions.length,
    analyzedRawAtoms,
    unsupportedRawAtoms,
    unclassifiedRawAtoms,
    provenIrrelevantRawAtoms,
    rawAtomDispositions,
    emptyScopeProven,
    unitIdentities: scopeUnits.map((unit) => unit.key),
    residualUnitIdentities,
    concernsFound: concerns.length > 0,
    discoveryIncomplete: !complete,
    complete,
  };
  const conclusion =
    concerns.length > 0 ? "CONCERNS_FOUND" : complete ? "ABSENCE_ESTABLISHED" : "INCOMPLETE";
  const completeness: EvidenceCompleteness =
    conclusion === "CONCERNS_FOUND"
      ? "NOT_APPLICABLE"
      : conclusion === "ABSENCE_ESTABLISHED"
        ? "COMPLETE"
        : "INCOMPLETE";
  // Coverage is relative to the claim. A concrete finding carries its own witness. Negative
  // absence is FULL only when concern coverage and promotion-authorized bounded claims leave no
  // residual; syntax classification alone has no such authority.
  const coverage: AnalysisCoverage =
    conclusion === "CONCERNS_FOUND"
      ? "NOT_APPLICABLE"
      : conclusion === "ABSENCE_ESTABLISHED"
        ? scopeUnits.length === 0
          ? "NOT_APPLICABLE"
          : "FULL"
        : readabilityCoverage === "UNSUPPORTED" || unsupportedUnits > 0 || unsupportedRawAtoms > 0
          ? "UNSUPPORTED"
          : "PARTIAL";
  // Concern findings and discovery incompleteness are independent facts. A positive witness may
  // settle adequacy only after every sibling unit has also been accounted for.
  const adequacyConclusion = !complete
    ? "INCOMPLETE"
    : concerns.length > 0
      ? "CONCERNS_FOUND"
      : "ABSENCE_ESTABLISHED";
  const adequacyCompleteness: EvidenceCompleteness =
    adequacyConclusion === "CONCERNS_FOUND"
      ? "NOT_APPLICABLE"
      : adequacyConclusion === "ABSENCE_ESTABLISHED"
        ? "COMPLETE"
        : "INCOMPLETE";
  const adequacyCoverage: AnalysisCoverage =
    adequacyConclusion === "INCOMPLETE"
      ? unsupportedUnits > 0 || unsupportedRawAtoms > 0
        ? "UNSUPPORTED"
        : "PARTIAL"
      : scopeUnits.length === 0
        ? "NOT_APPLICABLE"
        : "FULL";
  const accountingSummary =
    `changed-scope accounting (${scopeAccounting.unit}): total=${scopeAccounting.totalRelevantUnits}, ` +
    `concern-attributed=${scopeAccounting.concernAttributedUnits}, ` +
    `concern-covered=${scopeAccounting.concernCoveredUnits}, ` +
    `concern-partial=${scopeAccounting.partiallyConcernCoveredUnits}, ` +
    `syntax-classified=${scopeAccounting.syntaxClassifiedUnits}, ` +
    `promotion-absence=${scopeAccounting.promotionAbsenceEstablishedUnits}, ` +
    `fixed-argument-metadata=${scopeAccounting.fixedArgumentInvocationUnits}, ` +
    `unsupported=${scopeAccounting.unsupportedUnits}, ` +
    `unclassified-remainder=${scopeAccounting.unclassifiedRemainderUnits}; ` +
    `raw-atoms=${scopeAccounting.rawChangedAtoms}, raw-analyzed=${scopeAccounting.analyzedRawAtoms}, ` +
    `raw-unsupported=${scopeAccounting.unsupportedRawAtoms}, ` +
    `raw-unclassified=${scopeAccounting.unclassifiedRawAtoms}, ` +
    `raw-proven-irrelevant=${scopeAccounting.provenIrrelevantRawAtoms}`;
  const adequacyEvidence =
    adequacyConclusion === "CONCERNS_FOUND"
      ? [
          accountingSummary,
          `${concerns.length} concrete concern witness(es) were produced and every relevant changed-local unit is accounted for; their typed obligations, not this scope-adequacy record, own resolution`,
        ]
      : adequacyConclusion === "ABSENCE_ESTABLISHED"
        ? [
            accountingSummary,
            scopeUnits.length === 0
              ? `EMPTY_EXECUTABLE_SCOPE_WITH_CONSERVATION_CERTIFICATE: no executable statement remains because all ${rawAtomDispositions.length} raw changed atom(s) were positively proven irrelevant`
              : `all ${scopeUnits.length} relevant changed-local unit(s) were exhaustively accounted by concern-analysis scope or a promotion-authorized bounded structural claim: ${[
                  ...boundedClasses.entries(),
                ]
                  .map(([kind, count]) => `${kind}=${count}`)
                  .join(", ")}`,
            "syntax labels and promotion authority are separate: only the exact added numeric/local unquoted scalar and erased/name-resolution-only import claims accepted by this bounded policy can establish absence; unchanged consumers and whole-program behavior remain outside scope",
          ]
        : [
            accountingSummary,
            ...(concerns.length > 0
              ? [
                  `${concerns.length} concrete concern witness(es) coexist with an unresolved changed-scope remainder; finding typed work does not classify sibling units`,
                ]
              : []),
            ...(fixedArgumentInvocationUnits > 0
              ? [
                  `${fixedArgumentInvocationUnits} arbitrary invocation unit(s) have syntactically fixed arguments; argumentDynamism=FIXED is metadata and does not establish benign callee/action behavior`,
                ]
              : []),
            `scope-adequacy coverage is ${adequacyCoverage}; ${unsupportedRawAtoms + unclassifiedRawAtoms} raw atom(s) and ${unsupportedUnits + unclassifiedRemainderUnits} analyzed unit(s) remain unsupported or residual and must be resolved by stronger candidate-bound assurance before promotion`,
          ];
  if (concerns.length > 0) {
    evidence.push(
      `cross-language concern discovery raised ${concerns.length} material concern(s) from structural shapes in the diff's added code, independent of file path naming: ${[...new Set(concerns.map((item) => item.concern))].join(", ")}`,
    );
    for (const concern of concerns.slice(0, 10)) {
      evidence.push(
        `${concern.concern} in ${concern.file} (${concern.languageClass}) — ${concern.evidence}`,
      );
    }
  } else if (touchedClasses.length > 0) {
    evidence.push(
      conclusion === "ABSENCE_ESTABLISHED"
        ? `every one of the ${scopeUnits.length} relevant changed-local unit(s) was exhaustively covered by concern analysis or a promotion-authorized bounded claim inside this narrow scope`
        : `bounded positive discovery found no modelled concern shape across ${touchedClasses.join(", ")}, but ${unsupportedUnits + unclassifiedRemainderUnits} unsupported or residual unit(s) remain outside a complete negative proof; detector silence and syntax labels are insufficient evidence`,
    );
  } else {
    evidence.push("the diff contains no changed executable statement in the discovery scope");
  }
  evidence.push(
    `claim-relative concern-discovery coverage is ${coverage} with ${completeness} completeness (${conclusion}); positive detection reads local statement/call/boolean-decision shapes, while negative absence requires exhaustive concern coverage or an explicitly promotion-authorized bounded claim for every unit`,
    "the discovery capability does not claim type resolution, wrapper provenance outside the diff, interprocedural flow, cross-file flow, or complete recognition of arbitrary security behavior",
  );
  return {
    concerns,
    touchedClasses,
    coverage,
    conclusion,
    completeness,
    analysisScope:
      conclusion === "ABSENCE_ESTABLISHED"
        ? "all relevant changed-local units: exhaustively concern-covered, promotion-authorized bounded claims, or empty executable scope"
        : "bounded positive statement/call/boolean-decision shape discovery over changed executable statements",
    scopeAdequacy: {
      conclusion: adequacyConclusion,
      completeness: adequacyCompleteness,
      coverage: adequacyCoverage,
      analysisScope: complete
        ? `all ${scopeUnits.length} relevant changed-local statement unit(s), fully accounted by exact concern attribution or promotion-grade bounded classification`
        : `all ${scopeUnits.length} relevant changed-local statement unit(s), including ${unsupportedUnits} unsupported and ${unclassifiedRemainderUnits} unclassified remainder unit(s)`,
      evidence: adequacyEvidence,
    },
    scopeAccounting,
    evidence,
  };
};
