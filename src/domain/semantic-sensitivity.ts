import type { AnalysisCoverage } from "./assurance";
import { parseFilePatches } from "./diff-parse";

/**
 * Semantic sensitivity discovery (post-pilot hardening, Finding C): path-keyword heuristics can
 * only see risk that is named in a filename. A change that alters how hidden user input is
 * handled in a neutrally named file (the pilot's real false-low) is invisible to them. This
 * module derives SEMANTIC risk signals from what the diff's added lines actually do — call
 * hidden-input APIs, move credential-shaped values, make authorization decisions, touch key
 * material — so SecuritySensitivity can rise from LOW once real code evidence exists.
 *
 * Hardening pass #3 replaces pure regex vocabulary with bounded STRUCTURAL analysis (Part C) and
 * signal STRENGTH (Part D): a signal is STRUCTURAL when it is derived from the shape of the code
 * — a binding from a sensitive source call, a call configured to conceal input, a credential-named
 * assignment, an import alias that resolves to a known sensitive API, a propagated sensitive
 * binding reaching a sink — and merely LEXICAL when only a word matched. Lexical hints justify
 * cheap focused inspection; they do not by themselves escalate SecuritySensitivity or block
 * promotion. This is deliberately NOT interprocedural taint analysis: analysis is file-local,
 * name-based, and bounded (single-hop alias closure). Unresolvable shapes stay UNKNOWN-upstream —
 * false certainty is not manufactured here.
 */

export type SemanticSensitivitySignalKind =
  | "HIDDEN_INPUT"
  | "SECRET_HANDLING"
  | "CREDENTIAL_FLOW"
  | "AUTH_DECISION"
  | "CRYPTO_KEY_MATERIAL";

/**
 * LEXICAL: a vocabulary match only — evidence to look closer, not evidence of a sensitive flow.
 * STRUCTURAL: the code's shape (binding/call/argument/propagation) carries the sensitivity.
 */
export type SemanticSignalStrength = "LEXICAL" | "STRUCTURAL";

export interface SemanticSensitivityEvidence {
  signals: SemanticSensitivitySignalKind[];
  /** Kinds that have at least one STRUCTURAL hit. Subset of `signals`. */
  structuralSignals: SemanticSensitivitySignalKind[];
  /** One human-readable, file-bound string per distinct signal/file pair. */
  evidence: string[];
  /**
   * Source→sink pairs inside one file: an identifier bound to a sensitive source (hidden input,
   * credential, secret — including single-hop alias propagation) that an added line also routes
   * to an externally visible sink (a raised exception message, a log call, a print, stderr).
   * This is the shape of the pilot's missed leak — the code was correct except that a raw
   * sensitive value could escape through an error message. File-local and name-based: flagged,
   * not proven — this is not taint analysis.
   */
  exposurePairs: Array<{ file: string; source: string; sink: string }>;
  /**
   * Files whose added lines carry POTENTIALLY EXECUTABLE/BEHAVIORAL content (workflow/command
   * definitions in YAML/config, executable-named files) that this scanner cannot analyze.
   * "Scanner does not support this file" must not become "security NOT_REQUIRED": behavioral
   * content preserves uncertainty upstream. Markdown/fixture prose stays inert and never appears
   * here.
   */
  behavioralUnsupportedFiles: string[];
  /**
   * Semantic COVERAGE, as distinct from semantic RESULT (trust invariant E). This scanner's
   * constructs are Python / JavaScript-TypeScript / POSIX-shell idioms: a concealed-input call, a
   * credential-named binding, a raise/log/print sink. A `.go`, `.rs`, `.java`, `.cs` or `.swift`
   * file gets read, but the idioms that carry hidden-input and credential behaviour in those
   * languages (`term.ReadPassword`, `rpassword::read_password`, `Console.readPassword`,
   * `Console.ReadKey`) are not modelled — so "no signal" there is the absence of a look, not an
   * observation. `coverage` reports which it was; `unsupportedLanguageFiles` names the behavioural
   * files the scanner could not structurally read. Adding more language patterns would move files
   * between these lists; it would not change the need for the distinction.
   */
  coverage: AnalysisCoverage;
  /** Production files with behavioural added lines in a language this scanner does not model. */
  unsupportedLanguageFiles: string[];
  /** Production files scanned with idioms this scanner fully models. */
  supportedLanguageFiles: string[];
}

/**
 * Strips the CONTENTS of plain string literals, keeping the quotes, so prose cannot fire
 * signals. Strings that interpolate (`f'... {value}'`, template `` `...${value}` ``) are kept
 * whole: the interpolation is real code flow — the pilot's leak was exactly a sensitive value
 * interpolated into a raised error message, and erasing it would erase the evidence.
 */
const stripStringLiterals = (line: string): string =>
  line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1?/gu, (match, quote: string) =>
    /\$\{|\{[^}\s]/u.test(match) ? match : quote + quote,
  );

/** Lines that only DECLARE shapes or bring names into scope — no runtime behavior of their own. */
const declarationLinePattern =
  /^\s*(?:export\s+)?(?:type|interface|enum|import|from)\b|^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|function|fn|func|sub)\b/u;

/**
 * Constructs that read or configure concealed/hidden user input. Call/keyword-argument forms
 * only: a bare `hidden = true` UI flag or the word "hidden" in prose must not fire this.
 */
const hiddenInputPattern =
  /\bgetpass\s*\(|\bgetpass\s*\.\s*\w+\s*\(|\bhidden[_\s]?input\s*\(|\bhidden[_\s]?input\s*=|\bhide_?input\s*(?:=|\()|\bpwinput\s*\(|\bnoecho\b|\bread\s+-s\b|\bmask(?:ed|ing)?[_\s]?(?:input|value|secret)\s*[=(]|\bprompt\s*\([^)\n]{0,60}\b(?:secret|password|passwd|credential|token)\b|\b(?:secret|password|credential)[_\s]?prompt\s*\(/iu;

/**
 * STRUCTURAL concealed-input evidence (Part C): ANY call configured to conceal what it reads —
 * the function's own name does not matter, its concealment configuration does. `prompt(x,
 * hide_input=True)`, `ask(q, mask: true)`, `<input type="password">`, `echo=false` readline
 * configs — all are hidden-input sources regardless of the API being a framework nobody listed.
 */
const concealmentConfiguredCallPattern =
  /[A-Za-z_][\w.]*\s*\([^)\n]{0,100}\b(?:hide_?input|noecho|mask(?:ed|ing)?|conceal(?:d|ed)?|echo\s*=\s*(?:false|no|0)|type\s*=\s*["']?password)\b/iu;

/**
 * Identifiers that hold or name secret/credential material. Word-bounded forms for snake/dash
 * naming plus explicit camelCase compounds (`apiToken`, `clientSecret`, …) — a camel-bound
 * prefix list rather than a substring match, so `tokenizer`/`keynote` stay inert.
 */
const credentialIdentifierPattern =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|private[_-]?key|credential|token)\b|\b(?:(?:api|access|refresh|id|auth|session|client|user|bearer|csrf|reset|slack|gitlab|webhook)[Tt]okens?|[Cc]lientSecret|[Pp]rivateKey|[Aa]piKey|[Aa]ccessKey|[Ss]ecret[Kk]ey)\b/iu;

/**
 * Authorization-decision constructs. Either an explicit decision/check call, or the identifier
 * used inside a decision context (if/return/assert/while/switch/&&/||) — `is_admin` as a bare
 * field definition is data, `if (is_admin)` or `check_permission(...)` is a decision. Both forms
 * are use-shaped and therefore structural.
 */
const authDecisionCallPattern =
  /\bauthorize[d]?\s*\(|\brequire[sd]?_(?:auth|login|role|permission)\s*\(|\bhas_?(?:permission|role)\s*\(|\bcheck_?(?:permission|role|auth)\s*\(/iu;
const authDecisionContextPattern =
  /(?:\b(?:if|elif|else\s+if|while|switch|case|assert|return)\b|[&|?]{1,2})\s*[^\n]{0,50}\b(?:authorized?|require[sd]?_(?:auth|login|role|permission)|has_?(?:permission|role)|is_?admin|check_?(?:permission|role|auth))\b/iu;

/**
 * Cryptographic / key-material constructs. Call/binding forms are structural usage; a bare noun
 * (`private_key` mentioned with no call or assignment) is lexical vocabulary only.
 */
const cryptoCallOrBindingPattern =
  /\b(?:encrypt|decrypt)(?:ion|ed|ing)?\s*\(|\bhmac\s*\(|\bverify_?signature\s*\(|\bcipher\s*[=:(]|\b(?:private|public|signing)[_\s]?key[_\s]?(?:=|:|\()|\bkey_?material\s*[=:(]/iu;
const cryptoNounPattern =
  /\bprivate[_\s]?key\b|\bpublic[_\s]?key\b|\bsigning[_\s]?key\b|\bkey_?material\b/iu;

/** Externally visible sinks a sensitive value can leak through. */
const exposureSinkPattern =
  /\b(?:raise|throw)\b|\b(?:log|logger|logging)\s*[.(]|\blog(?:ging)?[_\s]?(?:error|warn|info|debug)\b|\bconsole\s*\.\s*(?:log|error|warn|info|debug)\b|\bprint(?:f|ln|w)?\s*\(|\b(?:exception|error)\s*(?:\(|f["']|["'])|\bprocess\s*\.\s*stderr\b|\bsys\s*\.\s*stderr\b|\bSystem\s*\.\s*err\b|\bwarnings\s*\.\s*warn\b|\bfprintf\s*\(\s*stderr\b/iu;

const nonProductionPath =
  /(^|\/)(?:tests?|__tests__|fixtures?|benchmarks?)(\/|$)|\.(?:test|spec)\.[^/]+$/iu;

/**
 * Semantic signals describe what executable code DOES. Prose or data artifacts (markdown reports,
 * notes, plain config) can mention credentials without any code behavior existing — scanning them
 * produces signal without substance (the fixture agent's own output report is the concrete case:
 * it *names* the credential references it was handed, and that mention is not a code flow). Only
 * plausibly-executable files are scanned; a file type outside this list is not silently risky,
 * it just carries no semantic evidence — the path heuristics in risk.ts still apply to it.
 */
const codeFilePath =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|php|pl|lua|sh|bash|zsh|fish|ps1|psm1|scala|clj|ex|exs|erl|hs|ml|mli|dart|vue|svelte|astro|r|jl|sql|hbs|ejs|erb|j2|twig|pug|mk|gradle)$/iu;

/**
 * Languages whose sensitive-behaviour IDIOMS this scanner actually models: Python, the
 * JavaScript/TypeScript family and POSIX shell. Every construct above was written against these —
 * `getpass(...)`, `hide_input=True`, `read -s`, `const token = ...`, `raise`/`throw`/`console.log`
 * sinks. A file in this set that produces no signal is a real observation.
 */
const fullyModelledLanguage = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|sh|bash|zsh)$/iu;

/**
 * Languages where the generic BINDING and NAMING shapes still transfer (`x = call(...)`,
 * credential-shaped identifiers, print/log sinks) but the language's own concealed-input and
 * error-propagation idioms are not modelled. Absence of signal here is weaker than an observation.
 */
const partiallyModelledLanguage =
  /\.(?:rb|php|pl|lua|r|jl|ex|exs|ps1|psm1|fish|vue|svelte|astro|hbs|ejs|erb|j2|twig|pug)$/iu;

/**
 * Behavioural files this scanner reads but does not structurally understand. The concealed-input,
 * credential-flow and exposure idioms of these languages (`term.ReadPassword(int(syscall.Stdin))`,
 * `rpassword::read_password()`, `System.console().readPassword()`, `Console.ReadKey(true)`,
 * `getpass_r`) share no shape with the modelled constructs, and their binding forms (`:=`,
 * `let mut`, typed declarations, method chains) are different again. Listing them is a COVERAGE
 * statement, not a detector: the point is that "no signal" in one of these files must never be
 * reported as if the scanner had looked and found nothing.
 */
const unmodelledLanguage =
  /\.(?:go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|scala|clj|erl|hs|ml|mli|dart|sql|mk|gradle)$/iu;

/**
 * Executable files with no extension. Evidence over extension: a shebang line in the added code,
 * or one of the well-known executable filenames, means the file is scannable regardless of
 * extension. Extensionless files without either remain unscanned (documentation, LICENSE, etc.).
 */
const knownExecutableFile =
  /(^|\/)(?:makefile|dockerfile|rakefile|taskfile|justfile|vagrantfile|gradlew|mvnw)(\.|$)/iu;
const hasShebangLine = (addedLines: string[]): boolean =>
  addedLines.some((line) => /^#!\s*\//u.test(line));

const isScannable = (file: string, addedLines: string[]): boolean =>
  codeFilePath.test(file) ||
  knownExecutableFile.test(file) ||
  (pathBasename(file).includes(".") === false && hasShebangLine(addedLines));

const pathBasename = (file: string): string => file.split("/").pop() ?? file;

type LanguageCoverage = "FULL" | "PARTIAL" | "UNSUPPORTED";

/**
 * Extensionless executables are classified by their shebang: a `sh`/`bash`/`python`/`node`
 * interpreter is modelled, anything else (`ruby`, `perl`, an unknown runtime) is not.
 */
const shebangCoverage = (addedLines: string[]): LanguageCoverage => {
  const shebang = addedLines.find((line) => /^#!\s*\//u.test(line)) ?? "";
  if (/\b(?:sh|bash|zsh|python[0-9.]*|node)\b/u.test(shebang)) return "FULL";
  return "UNSUPPORTED";
};

const languageCoverage = (file: string, addedLines: string[]): LanguageCoverage => {
  if (fullyModelledLanguage.test(file)) return "FULL";
  if (partiallyModelledLanguage.test(file)) return "PARTIAL";
  if (unmodelledLanguage.test(file)) return "UNSUPPORTED";
  if (knownExecutableFile.test(file)) return "PARTIAL";
  return shebangCoverage(addedLines);
};

/**
 * Combines per-file language coverage into the scan-wide verdict.
 *
 * A single unreadable behavioural file makes the whole scan UNSUPPORTED, not PARTIAL. The question
 * coverage answers is "can this scan's no-signal result be treated as an observation about this
 * candidate?" — and if any behavioural file went unread, the answer is no, however many other
 * files were read. Reporting PARTIAL for a mixed diff would let one modelled file launder an
 * unmodelled one. PARTIAL is therefore reserved for the genuinely partial case: every file was in
 * a language whose generic binding/naming shapes transfer, but whose own concealed-input idioms
 * are not modelled.
 */
const combineCoverage = (
  supported: string[],
  partial: string[],
  unsupported: string[],
): AnalysisCoverage => {
  if (unsupported.length > 0) return "UNSUPPORTED";
  if (partial.length > 0) return "PARTIAL";
  if (supported.length > 0) return "FULL";
  return "NOT_APPLICABLE";
};

/**
 * YAML/config/workflow files whose ADDED lines define commands or execution steps — behavioral
 * content this scanner cannot analyze (Part E). Keyed shapes only (`run:`, `script:`, `shell:`,
 * `command:`, `entrypoint:`, `exec:`): a version bump or prose change adds no behavioral line and
 * stays inert.
 */
const workflowBehavioralPath = /\.(?:ya?ml|toml|ini|cfg|conf)$/iu;
const workflowLocationPath =
  /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$/iu;
const workflowBehavioralLine = /^\s*-?\s*(?:run|script|shell|command|entrypoint|exec|steps)\s*:/u;

/**
 * Import-alias resolution (Part C): `import { getpass as gp }` / `from getpass import getpass as
 * gp` / `import getpass as gp` rename a sensitive API locally. Aliases are resolved per file
 * BEFORE pattern matching, so a renamed import is treated as the API it actually is. Bounded to
 * simple `x as y` specs on added import lines.
 */
const collectImportAliases = (lines: string[]): Map<string, string> => {
  const aliases = new Map<string, string>();
  const record = (specs: string, line: string): void => {
    for (const spec of specs.split(",")) {
      const named = spec.match(/([\w.]+)\s+as\s+(\w+)\s*$/u);
      if (named?.[1] && named[2]) aliases.set(named[2], named[1]);
    }
    // `import getpass as gp` / `import getpass.getpass as gp` — module-level alias, recorded only
    // when the module is one this scanner pattern-matches on, so `import numpy as np` stays inert.
    const moduleAlias = line.match(/\bimport\s+(getpass|pwinput)\s+as\s+(\w+)/iu);
    if (moduleAlias?.[1] && moduleAlias[2]) aliases.set(moduleAlias[2], moduleAlias[1]);
  };
  for (const line of lines) {
    // ES: import { a as b, c } from "m"
    for (const match of line.matchAll(/\{\s*([^}]+?)\s*\}\s*from\s*["'][^"']+["']/gu)) {
      if (match[1] !== undefined) record(match[1], line);
    }
    // Python: from m import a as b, c as d
    for (const match of line.matchAll(/\bfrom\s+[\w.]+\s+import\s+(.+)/gu)) {
      if (match[1] !== undefined) record(match[1].replace(/[()\\]/gu, ""), line);
    }
    record("", line);
  }
  return aliases;
};

const resolveAliases = (code: string, aliases: Map<string, string>): string => {
  if (aliases.size === 0) return code;
  let resolved = code;
  for (const [alias, original] of aliases) {
    resolved = resolved.replace(new RegExp(`\\b${alias}\\b`, "gu"), original);
  }
  return resolved;
};

/**
 * Collects candidate sensitive identifier names from a line (e.g. `value`, `pin`, `secret_input`).
 * When the SOURCE call is itself a hidden-input API (getpass, hidden_input, read -s, any call
 * carrying a concealment kwarg), the binding is sensitive regardless of the name — the pilot's
 * leak was exactly a neutrally named variable (`value = getpass(...)`) re-raised in an error
 * message. Dotted sources (click.prompt, window.prompt) are recognized. For generic input calls
 * (prompt, input, readline) a sensitive NAME is required, so ordinary form fields do not flood
 * the pairing.
 */
/** True when the line binds a value from a call that conceals its input (a hidden-input source). */
const bindsHiddenSource = (line: string): boolean => {
  if (concealmentConfiguredCallPattern.test(line)) return true;
  for (const match of line.matchAll(
    /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?(?:[\w.]+\.)?(getpass|hidden[_\s]?input|hide_?input|read\s+-s|pwinput)\b/giu,
  )) {
    if (match[1] !== undefined) return true;
  }
  return false;
};

const sensitiveIdentifiersOn = (line: string): string[] => {
  const results: string[] = [];
  const lineHidesInput =
    /hide_?input|hidden[_\s]?input|noecho|mask(?:ed)?[_\s]?(?:input|value)/iu.test(line) ||
    concealmentConfiguredCallPattern.test(line);
  for (const match of line.matchAll(
    /(?:(?:const|let|var|def|function|param|val)\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?(?:[\w.]+\.)?(getpass|hidden[_\s]?input|hide_?input|read\s+-s|pwinput|prompt|input|readline|read)\b/giu,
  )) {
    const name = match[1];
    const source = match[2];
    if (name === undefined || source === undefined) continue;
    const hiddenSource =
      /getpass|hidden|hide_?input|read\s+-s|pwinput/iu.test(source) || lineHidesInput;
    if (
      hiddenSource ||
      credentialIdentifierPattern.test(name) ||
      /hidden|secret|sensitive|mask|password|credential|token|key/iu.test(name)
    ) {
      results.push(name);
    }
  }
  // Concealment-configured call with an INVENTED API name: the known-source alternation above
  // cannot match (`prompt_for`, `ask_secure`, …), but the call's concealment configuration is
  // itself the evidence — any binding it feeds is a hidden-input source regardless of names.
  if (lineHidesInput) {
    for (const match of line.matchAll(
      /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?[A-Za-z_][\w.]*\s*\(/gu,
    )) {
      if (match[1] !== undefined) results.push(match[1]);
    }
  }
  return results;
};

export const deriveSemanticSensitivity = (
  patch: string,
  relevantFiles?: ReadonlySet<string>,
): SemanticSensitivityEvidence => {
  const signals = new Map<SemanticSensitivitySignalKind, string[]>();
  const structuralSignals = new Set<SemanticSensitivitySignalKind>();
  const evidence: string[] = [];
  const exposurePairs: Array<{ file: string; source: string; sink: string }> = [];
  const behavioralUnsupportedFiles: string[] = [];
  const supportedLanguageFiles: string[] = [];
  const partialLanguageFiles: string[] = [];
  const unsupportedLanguageFiles: string[] = [];
  const add = (kind: SemanticSensitivitySignalKind, file: string, structural: boolean): void => {
    signals.set(kind, [...new Set([...(signals.get(kind) ?? []), file])]);
    if (structural) structuralSignals.add(kind);
  };

  for (const entry of parseFilePatches(patch)) {
    if (relevantFiles !== undefined && !relevantFiles.has(entry.file)) continue;
    if (nonProductionPath.test(entry.file)) continue;
    // Shebang detection sees the RAW added lines — the `#!` line is itself a comment shape and
    // would be filtered out before it could prove the extensionless file is executable.
    if (!isScannable(entry.file, entry.addedLines)) {
      // Part E: behavioral-but-unsupported content preserves uncertainty. YAML/config/workflow
      // files whose added lines DEFINE commands or steps are potentially executable; this scanner
      // cannot analyze them, and "unsupported" must not become "NOT_REQUIRED" upstream.
      if (
        (workflowBehavioralPath.test(entry.file) || workflowLocationPath.test(entry.file)) &&
        entry.addedLines.some((line) => workflowBehavioralLine.test(line))
      ) {
        behavioralUnsupportedFiles.push(entry.file);
      }
      continue;
    }
    // Comment lines are not executable behavior — evidence must come from code the change runs.
    const rawCodeLines = entry.addedLines.filter(
      (line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line),
    );
    // Import lines are declaration-shaped but carry alias information needed below.
    const importLines = rawCodeLines.filter((line) => /^\s*(?:import|from)\b/u.test(line));
    // Declaration lines shape types, they do not move values; string contents are prose, not flow.
    const codeLines = rawCodeLines
      .filter((line) => !declarationLinePattern.test(line))
      .map(stripStringLiterals);
    const aliases = collectImportAliases(importLines);
    const code = resolveAliases(codeLines.join("\n"), aliases);
    if (code.trim().length === 0) continue;

    // COVERAGE, recorded before any signal is derived: a file the scanner reads with idioms it
    // does not model contributes "no signal" that is not an observation. Recorded per file so a
    // mixed diff (one modelled file, one unmodelled) reports PARTIAL rather than either extreme.
    const coverageOfFile = languageCoverage(entry.file, entry.addedLines);
    if (coverageOfFile === "FULL") supportedLanguageFiles.push(entry.file);
    else if (coverageOfFile === "PARTIAL") partialLanguageFiles.push(entry.file);
    else unsupportedLanguageFiles.push(entry.file);

    // HIDDEN_INPUT: structural when the input is bound (a value is captured from a hidden source)
    // or a call is explicitly configured to conceal; the API's own name is irrelevant. A
    // credential-NAMED binding from a plain input call is CREDENTIAL_FLOW, not hidden input.
    const hiddenStructural =
      concealmentConfiguredCallPattern.test(code) ||
      codeLines.some((line) => bindsHiddenSource(resolveAliases(line, aliases)));
    if (hiddenInputPattern.test(code) || concealmentConfiguredCallPattern.test(code))
      add("HIDDEN_INPUT", entry.file, hiddenStructural);

    // CREDENTIAL_FLOW: structural when a credential-named identifier is a BINDING TARGET (a value
    // is assigned/returned into it); a bare vocabulary mention is lexical.
    let credentialStructural = false;
    for (const binding of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?[^;\n]{3,}/giu)) {
      const name = binding[1];
      if (name !== undefined && credentialIdentifierPattern.test(name)) {
        credentialStructural = true;
        break;
      }
    }
    if (credentialIdentifierPattern.test(code))
      add("CREDENTIAL_FLOW", entry.file, credentialStructural);

    // AUTH_DECISION: both forms are use-shaped (a call, or a decision context) — structural.
    if (authDecisionCallPattern.test(code) || authDecisionContextPattern.test(code))
      add("AUTH_DECISION", entry.file, true);

    // CRYPTO: call/binding forms are structural usage; a bare noun is lexical.
    const cryptoStructural = cryptoCallOrBindingPattern.test(code);
    if (cryptoStructural || cryptoNounPattern.test(code))
      add("CRYPTO_KEY_MATERIAL", entry.file, cryptoStructural);

    // Secret-handling is the weakest (a bare word like "secret"); require it near handling verbs
    // so a mention alone does not fire it. Lexical by construction.
    if (
      /\b(?:secret|confidential|sensitive)\b/iu.test(code) &&
      /\b(?:mask|redact|scrub|conceal|store|load|read|write|handle|protect)\b/iu.test(code)
    )
      add("SECRET_HANDLING", entry.file, false);

    // Source→sink pairing with bounded alias propagation (Part C/D): a sensitive binding, plus
    // identifiers it is re-bound to (one-hop closure, ≤3 rounds), that also appear on a sink line
    // inside the same file. Deliberately file-local — cross-file flow needs a real data-flow
    // analysis this deterministic pass does not pretend to have.
    const sensitiveNames = new Set<string>();
    for (const line of codeLines) {
      for (const name of sensitiveIdentifiersOn(resolveAliases(line, aliases)))
        sensitiveNames.add(name);
    }
    for (let round = 0; round < 3; round += 1) {
      let grew = false;
      for (const line of codeLines) {
        for (const name of sensitiveNames) {
          const rebinding = new RegExp(
            `([A-Za-z_$][\\w$]*)\\s*[:=]\\s*(?:await\\s+)?(?:[A-Za-z_][\\w.]*\\.)?${name}\\b`,
            "u",
          ).exec(line);
          if (rebinding?.[1] && !sensitiveNames.has(rebinding[1])) {
            sensitiveNames.add(rebinding[1]);
            grew = true;
          }
        }
      }
      if (!grew) break;
    }
    for (const line of codeLines) {
      if (!exposureSinkPattern.test(line)) continue;
      for (const name of sensitiveNames) {
        if (new RegExp(`\\b${name}\\b`, "u").test(line)) {
          exposurePairs.push({ file: entry.file, source: name, sink: "externally-visible sink" });
        }
      }
    }
  }

  for (const [kind, files] of signals) {
    const strength = structuralSignals.has(kind) ? "structural" : "lexical (vocabulary hint only)";
    evidence.push(
      `${kind}: sensitive semantic construct(s) in added code of ${files.slice(0, 10).join(", ")} — ${strength}`,
    );
  }
  for (const pair of exposurePairs.slice(0, 10)) {
    evidence.push(
      `possible exposure: "${pair.source}" (sensitive input) also appears on a raise/log/print line in ${pair.file} — flagged, not proven`,
    );
  }
  for (const file of behavioralUnsupportedFiles.slice(0, 10)) {
    evidence.push(
      `behavioral content not analyzable by the semantic scanner: ${file} adds command/step definitions — unsupported analysis is not evidence of safety`,
    );
  }
  const coverage = combineCoverage(
    supportedLanguageFiles,
    partialLanguageFiles,
    unsupportedLanguageFiles,
  );
  if (unsupportedLanguageFiles.length > 0) {
    evidence.push(
      `semantic coverage ${coverage}: ${unsupportedLanguageFiles.length} behavioral file(s) are in a language whose hidden-input/credential idioms this scanner does not model (${unsupportedLanguageFiles.slice(0, 10).join(", ")}) — absence of a signal there is absence of a look, not an observation`,
    );
  } else if (partialLanguageFiles.length > 0) {
    evidence.push(
      `semantic coverage ${coverage}: ${partialLanguageFiles.length} behavioral file(s) match only the scanner generic binding/naming shapes, not their own language concealed-input idioms (${partialLanguageFiles.slice(0, 10).join(", ")})`,
    );
  }
  return {
    signals: [...signals.keys()],
    structuralSignals: [...structuralSignals],
    evidence,
    exposurePairs,
    behavioralUnsupportedFiles,
    coverage,
    unsupportedLanguageFiles,
    supportedLanguageFiles,
  };
};
