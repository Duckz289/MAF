/**
 * Bounded, language-neutral local syntax helpers.
 *
 * These helpers deliberately stop at statement and call-site structure. They do not resolve
 * types, callees, control flow across functions, or values across files. Their purpose is to make
 * local negative claims honest: every later identifier use is classified, and a command concern
 * is raised from an invoked boundary plus dynamic arguments rather than from an import or a word
 * appearing somewhere in a line.
 */

export interface LocalCallSite {
  callee: string;
  arguments: string[];
}

export interface SimpleLocalBinding {
  name: string;
  expression: string;
  declared: boolean;
}

export type DeclarationLanguage = "TS_JS" | "PYTHON" | "GO" | "RUST" | "KOTLIN" | "SWIFT" | "OTHER";

/**
 * A statement class whose material-boundary shape is completely known inside the changed local
 * statement. This is deliberately a small syntactic policy, not a vulnerability catalogue.
 */
export type BoundedDiscoveryStatementClass =
  | "FIXED_DATA_DECLARATION"
  | "DECLARATION_ONLY_IMPORT"
  | "LOCAL_SCALAR_COMPUTATION"
  | "FIXED_ARGUMENT_INVOCATION";

const flush = (statements: string[], buffer: string[]): void => {
  const statement = buffer.join("").trim();
  if (statement !== "") statements.push(statement);
  buffer.length = 0;
};

/**
 * Splits added code into bounded local statements while preserving multiline calls and computed
 * expressions. Braces are intentionally not treated as continuation delimiters: doing so would
 * turn an entire function body into one statement and hide later uses inside it.
 */
export const splitLocalStatements = (lines: string[]): string[] => {
  const statements: string[] = [];
  const buffer: string[] = [];
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      buffer.push(character);
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") parenthesisDepth += 1;
      else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === ";" && parenthesisDepth === 0 && bracketDepth === 0) {
        flush(statements, buffer);
      }
    }
    const continuation = /(?:[=,:?]|\+|-|\*|\/|&&|\|\||\?\?)\s*$/u.test(buffer.join(""));
    if (parenthesisDepth === 0 && bracketDepth === 0 && quote === null && !continuation) {
      flush(statements, buffer);
    } else {
      buffer.push("\n");
    }
  }
  flush(statements, buffer);
  return statements;
};

const splitArguments = (value: string): string[] => {
  const arguments_: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if ("([{<".includes(character)) depth += 1;
    else if ([")", "]", "}", ">"].includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      arguments_.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last !== "") arguments_.push(last);
  return arguments_;
};

const closingParenthesis = (value: string, opening: number): number => {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = opening; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/** Extracts parenthesized call sites without asserting what any callee means. */
export const extractLocalCallSites = (statement: string): LocalCallSite[] => {
  // Zero-argument accessors inside a call chain are structurally transparent for the purpose of
  // finding the outer receiver: Runtime.getRuntime().exec(value) becomes
  // Runtime.getRuntime.exec(value). No source fact is invented; only empty parentheses disappear.
  const normalized = statement.replace(/\(\s*\)(?=\s*(?:\.|::|->))/gu, "");
  const sites: LocalCallSite[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== "(") continue;
    const prefix = normalized.slice(0, index);
    const callee = prefix.match(
      /(?:^|[^\w$])((?:new\s+)?[A-Za-z_$][\w$]*(?:\s*(?:\.|::|->)\s*[A-Za-z_$][\w$]*)*)\s*$/u,
    )?.[1];
    if (!callee) continue;
    const closing = closingParenthesis(normalized, index);
    if (closing < 0) continue;
    sites.push({
      callee: callee.trim(),
      arguments: splitArguments(normalized.slice(index + 1, closing)),
    });
  }
  return sites;
};

const unwrapTransparentParentheses = (expression: string): string => {
  let normalized = expression.trim();
  while (
    normalized.startsWith("(") &&
    closingParenthesis(normalized, 0) === normalized.length - 1
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
};

const normalizeDirectExpression = (expression: string): string => {
  let normalized = expression.trim();
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = unwrapTransparentParentheses(normalized);
    normalized = normalized.replace(/^await\b\s*/iu, "").trim();
  }
  return normalized;
};

/**
 * Returns one direct call only when the complete expression is that call after transparent
 * `await`/parenthesis wrappers are removed. The prefix before the opening parenthesis must itself
 * be exactly a callee path. This is intentionally stricter than a greedy `callee(...)` regular
 * expression: a prefix/suffix, comma/boolean/arithmetic/ternary sibling, assignment, or second call
 * leaves residual expression scope and returns null.
 */
export const directLocalCallExpression = (expression: string): LocalCallSite | null => {
  const normalized = normalizeDirectExpression(expression);
  const opening = normalized.indexOf("(");
  if (opening <= 0 || closingParenthesis(normalized, opening) !== normalized.length - 1)
    return null;
  const callee = normalized.slice(0, opening).trim();
  if (!/^(?:new\s+)?[A-Za-z_$][\w$]*(?:\s*(?:\.|::|->)\s*[A-Za-z_$][\w$]*)*$/u.test(callee)) {
    return null;
  }
  const sites = extractLocalCallSites(normalized);
  return sites.length === 1 ? (sites[0] ?? null) : null;
};

const executionModule = (value: string): boolean =>
  /(?:^|[/_.-])(?:child[_-]?process|subprocess|process|shell|exec)(?:$|[/_.-])/iu.test(value);

/**
 * Resolves aliases only from import/dependency declarations present in the changed statements.
 * An alias is capability provenance, not a concern by itself; it matters only when invoked later.
 */
const executionBindings = (statements: string[]): Set<string> => {
  const bindings = new Set<string>();
  for (const statement of statements) {
    const jsImport = statement.match(/\bimport\s+(.+?)\s+from\s+["']([^"']+)["']/u);
    if (jsImport?.[1] && jsImport[2] && executionModule(jsImport[2])) {
      for (const item of jsImport[1].replace(/[{}]/gu, "").split(",")) {
        const local = item
          .trim()
          .split(/\s+as\s+/iu)
          .at(-1)
          ?.trim();
        if (local && /^[A-Za-z_$][\w$]*$/u.test(local)) bindings.add(local);
      }
    }
    const required = statement.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/u,
    );
    if (required?.[1] && required[2] && executionModule(required[2])) bindings.add(required[1]);
    const pythonModule = statement.match(/^\s*import\s+([\w.]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?/u);
    if (pythonModule?.[1] && executionModule(pythonModule[1])) {
      bindings.add(pythonModule[2] ?? pythonModule[1].split(".").at(-1) ?? pythonModule[1]);
    }
    const pythonFrom = statement.match(
      /^\s*from\s+([\w.]+)\s+import\s+([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/u,
    );
    if (pythonFrom?.[1] && executionModule(pythonFrom[1])) {
      bindings.add(pythonFrom[3] ?? pythonFrom[2] ?? "");
    }
    const namespaceImport = statement.match(
      /\b([A-Za-z_$][\w$]*)\s+["']([^"']*(?:process|shell|exec)[^"']*)["']/iu,
    );
    if (namespaceImport?.[1] && namespaceImport[2] && executionModule(namespaceImport[2])) {
      bindings.add(namespaceImport[1]);
    }
  }
  return bindings;
};

/** Whether an expression consists only of fixed literal data in this bounded syntax. */
export const isFixedLiteralExpression = (value: string): boolean => {
  const trimmed = value.trim().replace(/^&/u, "").trim();
  if (trimmed === "") return true;
  if (
    /^(?:true|false|null|nil|none|undefined|[-+]?(?:0[xob][0-9a-f](?:_?[0-9a-f])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?)n?)$/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  const quoted = inspectQuotedRegions(trimmed);
  if (
    !quoted.unbalanced &&
    quoted.regions.length === 1 &&
    quoted.regions[0]?.start === 0 &&
    quoted.regions[0].end === trimmed.length &&
    !quoted.regions[0].interpolating
  ) {
    return true;
  }
  if (/^`(?:\\.|[^`$]|\$(?!\{))*`$/su.test(trimmed)) return true;
  const namedLiteral = trimmed.match(/^[A-Za-z_$][\w$]*\s*[:=]\s*(.+)$/su)?.[1];
  if (namedLiteral !== undefined) return isFixedLiteralExpression(namedLiteral);
  const collection = trimmed.match(/^([[{])(.*)([\]}])$/su);
  if (collection?.[2] !== undefined) {
    return splitArguments(collection[2]).every((item) => isFixedLiteralExpression(item));
  }
  return false;
};

const isPrimitiveLiteralExpression = (value: string): boolean => {
  const trimmed = unwrapTransparentParentheses(value);
  if (
    /^(?:true|false|null|nil|none|undefined|[-+]?(?:0[xob][0-9a-f](?:_?[0-9a-f])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?)n?)$/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  const quoted = inspectQuotedRegions(trimmed);
  return (
    !quoted.unbalanced &&
    quoted.regions.length === 1 &&
    quoted.regions[0]?.start === 0 &&
    quoted.regions[0].end === trimmed.length &&
    !quoted.regions[0].interpolating
  );
};

/**
 * Whether evaluation of every direct-source-call argument is completely inside the bounded source
 * capability's scope. Only primitive literals (and Python keyword names whose values are primitive
 * literals) are transparent here. Calls, assignment/comma expressions, stores, property reads,
 * collection/object construction, interpolation, and other opaque evaluation remain residual.
 */
export const directSourceCallArgumentsCovered = (
  call: LocalCallSite,
  language: DeclarationLanguage,
): boolean =>
  call.arguments.every((argument) => {
    const keywordValue =
      language === "PYTHON" ? argument.match(/^[A-Za-z_][\w]*\s*=\s*([\s\S]+)$/u)?.[1] : undefined;
    return isPrimitiveLiteralExpression(keywordValue ?? argument);
  });

/** Finds a top-level assignment without mistaking comparisons, arrows, or nested arguments for one. */
const topLevelAssignment = (statement: string): number => {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if ("([{<".includes(character)) depth += 1;
    else if ([")", "]", "}", ">"].includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "=" && depth === 0) {
      const previous = statement[index - 1] ?? "";
      const next = statement[index + 1] ?? "";
      if (!"=!<>".includes(previous) && next !== "=" && next !== ">") return index;
    }
  }
  return -1;
};

/**
 * Extracts only a simple identifier binding. Exported/qualified/destructured stores deliberately
 * do not match: they are propagation boundaries, not local bindings. Bare identifiers support
 * Python-style assignment; declaration keywords support the common local declaration forms.
 */
export const extractSimpleLocalBinding = (statement: string): SimpleLocalBinding | null => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const assignment = topLevelAssignment(normalized);
  if (assignment < 0) return null;
  const left = normalized.slice(0, assignment).trim().replace(/:\s*$/u, "").trim();
  const expression = normalized.slice(assignment + 1).trim();
  const match = left.match(
    /^(?:(const|let|var|val|my|def|param)\s+)?(?:mut\s+)?([A-Za-z_$][\w$]*)(?:\s*:\s*.+)?$/u,
  );
  if (!match?.[2] || expression === "") return null;
  return { name: match[2], expression, declared: match[1] !== undefined };
};

export interface QuotedRegion {
  /** Inclusive index of the opening delimiter. */
  start: number;
  /** Exclusive index after the closing delimiter. */
  end: number;
  content: string;
  /**
   * True when the region can expand identifiers (templates, prefixed interpolating strings, or
   * quoted text containing expansion markers). Proven-plain literals are false.
   */
  interpolating: boolean;
}

export interface QuotedRegionInspection {
  regions: QuotedRegion[];
  unbalanced: boolean;
}

const quotePrefixAt = (value: string, quoteIndex: number): string => {
  let start = quoteIndex;
  while (start > 0 && /[A-Za-z]/u.test(value[start - 1] ?? "")) start -= 1;
  return value.slice(start, quoteIndex);
};

const tripleDelimiterAt = (value: string, index: number, quote: "'" | '"'): boolean =>
  value[index] === quote && value[index + 1] === quote && value[index + 2] === quote;

const regionInterpolates = (delimiter: string, prefix: string, content: string): boolean =>
  delimiter === "`" || /f/iu.test(prefix) || /[%$]|\{|#\{/u.test(content);

/**
 * Classifies quoted/template regions so negative local analysis can prove which strings are
 * inert literals. Expansion-capable regions are kept; they may hide identifier uses.
 */
export const inspectQuotedRegions = (value: string): QuotedRegionInspection => {
  const regions: QuotedRegion[] = [];
  let quote: "'" | '"' | "`" | "'''" | '"""' | null = null;
  let quoteStart = 0;
  let regionStart = 0;
  let prefix = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote === "'" || quote === '"' || quote === "`") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) {
        const content = value.slice(quoteStart, index);
        regions.push({
          start: regionStart,
          end: index + 1,
          content,
          interpolating: regionInterpolates(quote, prefix, content),
        });
        quote = null;
      }
      continue;
    }
    if (quote === "'''" || quote === '"""') {
      const delimiter = quote[0] === "'" ? "'" : '"';
      if (tripleDelimiterAt(value, index, delimiter)) {
        const content = value.slice(quoteStart, index);
        regions.push({
          start: regionStart,
          end: index + 3,
          content,
          interpolating: regionInterpolates(quote, prefix, content),
        });
        quote = null;
        index += 2;
      }
      continue;
    }
    if (character === "`") {
      quote = "`";
      prefix = quotePrefixAt(value, index);
      regionStart = index;
      quoteStart = index + 1;
      continue;
    }
    if (character === "'" || character === '"') {
      prefix = quotePrefixAt(value, index);
      regionStart = index - prefix.length;
      if (tripleDelimiterAt(value, index, character)) {
        quote = character === "'" ? "'''" : '"""';
        quoteStart = index + 3;
        index += 2;
      } else {
        quote = character;
        quoteStart = index + 1;
      }
    }
  }
  return { regions, unbalanced: quote !== null };
};

/** Removes only proven-non-interpolating quoted regions. Expansion-capable text is kept. */
export const stripProvenPlainQuotedRegions = (value: string): string => {
  const inspection = inspectQuotedRegions(value);
  if (inspection.unbalanced) return value;
  let stripped = "";
  let cursor = 0;
  for (const region of inspection.regions) {
    stripped += value.slice(cursor, region.start);
    if (region.interpolating) stripped += value.slice(region.start, region.end);
    cursor = region.end;
  }
  return stripped + value.slice(cursor);
};

/**
 * Whether `name` occurs as a value token, including `$name` / `${name}` expansion forms.
 * Word characters and `$` are not treated as a hard boundary before a shell/PHP expansion.
 */
export const identifierOccursIn = (code: string, name: string): boolean => {
  if (name === "") return false;
  const token = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (new RegExp(`(?<![\\w$])${token}(?![\\w$])`, "u").test(code)) return true;
  if (name.startsWith("$")) return false;
  return new RegExp(`\\$\\s*(?:\\{\\s*)?${token}(?:\\s*\\})?(?![\\w$])`, "u").test(code);
};

/** Dynamic-argument call sites. Used to record that execution-boundary silence is incomplete. */
export const dynamicArgumentCallSites = (statements: string[]): LocalCallSite[] => {
  const sites: LocalCallSite[] = [];
  for (const statement of statements) {
    for (const site of extractLocalCallSites(statement)) {
      if (
        site.arguments.length > 0 &&
        !site.arguments.every((argument) => isFixedLiteralExpression(argument))
      ) {
        sites.push(site);
      }
    }
  }
  return sites;
};

export const declarationLanguageOf = (file: string): DeclarationLanguage => {
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro)$/iu.test(file)) return "TS_JS";
  if (/\.(?:py|pyi)$/iu.test(file)) return "PYTHON";
  if (/\.go$/iu.test(file)) return "GO";
  if (/\.rs$/iu.test(file)) return "RUST";
  if (/\.kts?$/iu.test(file)) return "KOTLIN";
  if (/\.swift$/iu.test(file)) return "SWIFT";
  return "OTHER";
};

/**
 * The comment syntax a file's language actually uses.
 *
 * A single global prefix list (`//`, `#`, `--`, `*`, `;`, `/*`) is not a comment parser, and using
 * one as proof of non-executability erased real behavior before it could ever become a changed
 * unit (RC3a). The collisions are ordinary code, not exotica:
 *
 *   `--lockCount`        a JS/TS decrement, not a SQL comment
 *   `#define EXEC(x)`    a C preprocessor directive, not a shell comment
 *   `*handler = fn;`     a C pointer store, not a block-comment continuation
 *   `/* * / exec(cmd)`   a CLOSED block comment followed by executable code on the same line
 *
 * So comment-ness is established per language, and only when the whole line is positively proven
 * to be a comment. Anything else stays in scope. Unfamiliar languages fail closed: their text
 * remains inspectable material rather than being assumed inert.
 */
interface CommentSyntax {
  /** Prefixes that comment out the remainder of the line, in this language. */
  lineComments: string[];
  /** Paired block delimiters, when the language has them. */
  block?: { open: string; close: string };
}

const commentSyntaxFor = (language: DeclarationLanguage, file: string): CommentSyntax | null => {
  switch (language) {
    case "TS_JS":
    case "GO":
    case "RUST":
    case "KOTLIN":
    case "SWIFT":
      return { lineComments: ["//"], block: { open: "/*", close: "*/" } };
    case "PYTHON":
      return { lineComments: ["#"] };
    case "OTHER":
      break;
  }
  // A small, explicit extension map for the remaining families whose lexical comment form is
  // unambiguous. Everything absent from this map is deliberately unknown, not assumed inert.
  if (/\.(?:c|h|cc|cpp|hpp|cs|java|scala|dart|php|m|mm)$/iu.test(file)) {
    return { lineComments: ["//"], block: { open: "/*", close: "*/" } };
  }
  if (/\.(?:sh|bash|zsh|fish|rb|pl|r|yml|yaml|toml|ini|cfg|conf)$/iu.test(file)) {
    return { lineComments: ["#"] };
  }
  if (/\.sql$/iu.test(file)) {
    return { lineComments: ["--"], block: { open: "/*", close: "*/" } };
  }
  if (/\.lua$/iu.test(file)) {
    return { lineComments: ["--"] };
  }
  return null;
};

/** Comment-shaped material with compiler, build, loader, or runtime directive semantics. */
export const isBehavioralDirectiveLine = (
  line: string,
  language: DeclarationLanguage,
  file: string,
): boolean => {
  const trimmed = line.trim();
  if (trimmed.startsWith("#!")) return true;
  if (language === "TS_JS") {
    return (
      /^\/\/\//u.test(trimmed) ||
      /^\/\/[#@]\s*(?:sourceMappingURL|sourceURL|jsx|jsxImportSource)\b/iu.test(trimmed) ||
      /^\/\*\s*[@#]\s*(?:jsx|jsxImportSource)\b/iu.test(trimmed)
    );
  }
  if (language === "GO") {
    return /^\/\/(?:go:|\s*\+build\b|\s*#cgo\b)/u.test(trimmed);
  }
  if (language === "PYTHON") {
    return /^#\s*(?:-\*-.*coding|coding\s*[:=]|type:|pyright:|mypy:|noqa\b)/iu.test(trimmed);
  }
  return /\.(?:sh|bash|zsh|fish)$/iu.test(file) && trimmed.startsWith("#!");
};

/**
 * Whether the COMPLETE line is positively proven to be a comment in this file's language.
 *
 * A line-comment prefix proves comment-ness for the rest of the line. A block comment proves it
 * only when the block does not CLOSE on the same line — `/* note * / exec(cmd)` re-enters
 * executable text after the close and must remain scope. When no comment syntax is known for the
 * file, nothing is proven and the line stays inspectable.
 */
export const isProvenCommentLine = (
  line: string,
  language: DeclarationLanguage,
  file: string,
): boolean => {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  const syntax = commentSyntaxFor(language, file);
  if (syntax === null) return false;
  if (isBehavioralDirectiveLine(line, language, file)) return false;
  if (/\.lua$/iu.test(file)) {
    const long = trimmed.match(/^--\[(=*)\[/u);
    if (long?.[1] !== undefined) {
      const close = `]${long[1]}]`;
      const closeIndex = trimmed.indexOf(close, long[0].length);
      return closeIndex < 0 || trimmed.slice(closeIndex + close.length).trim() === "";
    }
  }
  if (syntax.lineComments.some((prefix) => trimmed.startsWith(prefix))) return true;
  const block = syntax.block;
  if (block !== undefined && trimmed.startsWith(block.open)) {
    const closeIndex = trimmed.indexOf(block.close, block.open.length);
    // Unclosed on this line: the whole line is inside the comment. Closed on this line: whatever
    // follows the close is executable text and must not be erased with the comment.
    return closeIndex < 0 || trimmed.slice(closeIndex + block.close.length).trim() === "";
  }
  return false;
};

const fixedDataDeclarationLeft = (left: string, language: DeclarationLanguage): boolean => {
  switch (language) {
    case "TS_JS":
      return /^(?:(?:export|default|public|private|protected|static|final|readonly|declare)\s+)*(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*.+)?$/u.test(
        left,
      );
    case "PYTHON":
      // Assignment is the language's local binding form; every identifier is treated the same.
      // No SCREAMING_SNAKE vocabulary is consulted.
      return /^[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(left);
    case "GO":
      return (
        /^(?:const|var)\s+[A-Za-z_][\w]*(?:\s+[^=]+)?$/u.test(left) ||
        /^[A-Za-z_][\w]*\s*:\s*$/u.test(left)
      );
    case "RUST":
      return /^(?:(?:pub(?:\([^)]*\))?|static)\s+)*(?:const|static|let)\s+(?:mut\s+)?[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(
        left,
      );
    case "KOTLIN":
      return /^(?:(?:public|private|protected|internal|const|lateinit)\s+)*(?:val|var)\s+[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(
        left,
      );
    case "SWIFT":
      return /^(?:(?:public|private|fileprivate|internal|open|static|class)\s+)*(?:let|var)\s+[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(
        left,
      );
    case "OTHER":
      return false;
  }
};

/**
 * A bounded syntax label: the statement only declares fixed literal data according to the actual
 * language's binding grammar. This does not classify arbitrary behavior, the declaration's
 * consumers, or promotion authority. Callers separately decide whether the exact literal,
 * visibility, and change direction can establish absence.
 */
export const isFixedDataDeclaration = (
  statement: string,
  language: DeclarationLanguage,
): boolean => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const assignment = topLevelAssignment(normalized);
  if (assignment < 0) return false;
  const left = normalized.slice(0, assignment).trim();
  const expression = normalized.slice(assignment + 1).trim();
  return fixedDataDeclarationLeft(left, language) && isFixedLiteralExpression(expression);
};

const directExecutionConcept = (callee: string): boolean =>
  /^(?:(?:shell)?exec(?:ute)?|spawn|system|popen|shell|command|launch)(?:sync|async)?$/iu.test(
    callee.replace(/[_-]/gu, ""),
  );

const receiverConcept = (value: string): boolean =>
  /^(?:process|subprocess|childprocess|runtime|command|shell|executor)(?:builder)?$/iu.test(
    value.replace(/[_-]/gu, ""),
  );

const normalizedSegments = (callee: string): string[] =>
  callee
    .replace(/^new\s+/iu, "")
    .split(/\s*(?:\.|::|->)\s*/u)
    .filter(Boolean);

/**
 * Returns the first statement that structurally hands a dynamic value to a command/process
 * boundary, or null when none is represented.
 *
 * Boundary identity comes from invoked import provenance, a process/command receiver, a builder
 * chain, or a high-specificity bare execution concept. A mere import/reference cannot match.
 * Fixed literal arguments cannot match. This remains local and syntactic: unchanged imports,
 * wrappers whose type is not visible, and non-parenthesized DSLs may remain outside coverage.
 */
export const dynamicCommandBoundary = (statements: string[]): string | null => {
  const bindings = executionBindings(statements);
  for (const statement of statements) {
    const sites = extractLocalCallSites(statement);
    for (const site of sites) {
      if (
        site.arguments.length === 0 ||
        site.arguments.every((argument) => isFixedLiteralExpression(argument))
      ) {
        continue;
      }
      const segments = normalizedSegments(site.callee);
      const first = segments[0] ?? "";
      const last = segments.at(-1) ?? "";
      const invokedImportedCapability = bindings.has(first) || bindings.has(last);
      const invokedReceiver = segments.slice(0, -1).some((segment) => receiverConcept(segment));
      const constructedBoundary = /^new\s+/iu.test(site.callee) && receiverConcept(first);
      const builderChain =
        /\b(?:process|subprocess|child[_-]?process|runtime|command|shell|executor)(?:builder)?\b\s*(?:\.|::|->)/iu.test(
          statement,
        );
      if (
        invokedImportedCapability ||
        invokedReceiver ||
        constructedBoundary ||
        builderChain ||
        directExecutionConcept(last)
      ) {
        return statement;
      }
    }
    // POSIX shell's execution form has no call parentheses. Treat only command position as a
    // boundary and still require expansion/dynamic input; a quoted fixed command stays quiet.
    if (/^\s*(?:exec|eval)\s+.*(?:\$[A-Za-z_{]|`|\$\()/u.test(statement)) return statement;
  }
  return null;
};

const declarationOnlyImport = (statement: string, language: DeclarationLanguage): boolean => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  return (
    // TypeScript's explicit `import type` is erased from runtime output. A value import or a bare
    // side-effect import is not in this class because loading its module may execute initialization.
    (language === "TS_JS" &&
      /^import\s+type\s+[\s\S]+\s+from\s+["'][^"']+["']$/u.test(normalized)) ||
    // Rust `use` changes name resolution only; it does not load/initialize a module at runtime.
    (language === "RUST" && /^use\s+[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$*{}]*)*$/u.test(normalized))
  );
};

/**
 * A bounded EFFECT-FREE scalar grammar.
 *
 * The previous form stripped tokens and validated a permissive remainder ALPHABET. That is unsound
 * as promotion authority: any construct whose characters happen to fall inside the remainder
 * alphabet survives, so `(enabled = 1)`, `(enabled += 1)`, `delete enabled`, `yield 1` and a regex
 * operand all normalized into "scalar" shapes. Detector-shaped silence became absence.
 *
 * This replaces the alphabet test with a positive recognizer: the COMPLETE expression is tokenized
 * over a closed vocabulary and parsed by a small recursive-descent grammar whose every production
 * is effect-free by construction. Nothing outside the grammar is admitted at any nesting depth, so
 * the default for unproven syntax is "not promotion-authorized" rather than "probably scalar".
 *
 * Proven pure: numeric/boolean/null literals, proven-plain (non-interpolating) string literals,
 * identifiers, `.length`/`.size` observations, parenthesization, the scalar unary/binary/ternary
 * operator set.
 *
 * Deliberately UNSUPPORTED (residual, never absence): assignment and compound assignment in every
 * form, update/mutation operators, delete/store operations, yield/await and other control-effect
 * operators, calls and construction, sequence expressions, indexing and arbitrary property access,
 * interpolation, regular-expression literals, and any token the bounded lexer does not understand.
 */

type ScalarToken =
  | { kind: "NUMBER" }
  | { kind: "STRING" }
  | { kind: "IDENT"; value: string }
  | { kind: "PUNCT"; value: string };

/**
 * Punctuation admitted by the effect-free grammar, longest match first. Update operators (`++`,
 * `--`) and the assignment family are deliberately absent: they must fail to tokenize rather than
 * decompose into a sequence of individually-pure unary operators, which is exactly how `--count`
 * previously read as a double negation.
 */
const scalarPunctuation = [
  ">>>",
  "===",
  "!==",
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "<<",
  ">>",
  "(",
  ")",
  "?",
  ":",
  ".",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "~",
  "&",
  "|",
  "^",
] as const;

/** Words that introduce an effect, a binding, or evaluation this grammar does not model. */
const nonScalarWord =
  /^(?:yield|await|delete|new|void|typeof|function|class|in|instanceof|of|throw|return|import|export|this|super|arguments|let|const|var|if|else|while|for|do|switch|case|try|catch|finally|with|debugger|async|static|get|set)$/u;

const literalWord = /^(?:true|false|null|nil|none|undefined)$/iu;

const numericLiteral =
  /^(?:0[xob][0-9a-f](?:_?[0-9a-f])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:e[-+]?\d+)?)n?/iu;

/**
 * Tokenizes an expression over the closed scalar vocabulary. Returns null the moment anything
 * outside that vocabulary appears — an unknown character, an assignment/update operator, a regular
 * expression literal, or an interpolating quoted region.
 */
const tokenizeScalarExpression = (expression: string): ScalarToken[] | null => {
  const quoted = inspectQuotedRegions(expression);
  if (quoted.unbalanced || quoted.regions.some((region) => region.interpolating)) return null;
  const stringStarts = new Map(quoted.regions.map((region) => [region.start, region.end]));
  const tokens: ScalarToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    const stringEnd = stringStarts.get(index);
    if (stringEnd !== undefined) {
      tokens.push({ kind: "STRING" });
      index = stringEnd;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") return null;
    const numeric = expression.slice(index).match(numericLiteral)?.[0];
    if (numeric !== undefined && /[0-9]/u.test(character)) {
      tokens.push({ kind: "NUMBER" });
      index += numeric.length;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const word = expression.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0] ?? "";
      if (nonScalarWord.test(word)) return null;
      tokens.push({ kind: "IDENT", value: word });
      index += word.length;
      continue;
    }
    // `++`/`--`/`=`-family and any unlisted punctuation must reject, not decompose.
    if (
      expression.startsWith("++", index) ||
      expression.startsWith("--", index) ||
      expression.startsWith("=", index) ||
      expression[index + 1] === "="
    ) {
      // `<=`, `>=`, `!=`, `==` are legitimate comparisons and are matched below; every other
      // `<punct>=` pair is an assignment form.
      const comparison = ["===", "!==", "==", "!=", "<=", ">="].find((operator) =>
        expression.startsWith(operator, index),
      );
      if (comparison === undefined) return null;
      tokens.push({ kind: "PUNCT", value: comparison });
      index += comparison.length;
      continue;
    }
    if (character === "/") {
      // Division only in operator position. A `/` in operand position starts a regular-expression
      // literal, whose punctuation must never be read as arithmetic.
      const previous = tokens.at(-1);
      const afterOperand =
        previous !== undefined &&
        (previous.kind === "NUMBER" ||
          previous.kind === "STRING" ||
          previous.kind === "IDENT" ||
          (previous.kind === "PUNCT" && previous.value === ")"));
      if (!afterOperand) return null;
    }
    const punctuation = scalarPunctuation.find((operator) =>
      expression.startsWith(operator, index),
    );
    if (punctuation === undefined) return null;
    tokens.push({ kind: "PUNCT", value: punctuation });
    index += punctuation.length;
  }
  return tokens;
};

const scalarBinaryOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "&&",
  "||",
  "??",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);

const scalarUnaryOperators = new Set(["!", "-", "+", "~"]);

/** The property observations the bounded contract models. Anything else escapes local scope. */
const scalarObservationProperty = /^(?:length|size)$/u;

/**
 * Recursive-descent proof that the token stream is one effect-free scalar expression. Every
 * production is pure; there is no production for assignment, call, index, or sequence, so those
 * shapes cannot be derived at any depth.
 */
const parseEffectFreeScalar = (tokens: ScalarToken[]): boolean => {
  let cursor = 0;
  const peek = (): ScalarToken | undefined => tokens[cursor];
  const punctIs = (value: string): boolean => {
    const token = peek();
    return token?.kind === "PUNCT" && token.value === value;
  };

  const parsePrimary = (): boolean => {
    const token = peek();
    if (token === undefined) return false;
    if (token.kind === "NUMBER" || token.kind === "STRING") {
      cursor += 1;
      return true;
    }
    if (token.kind === "IDENT") {
      cursor += 1;
      if (!literalWord.test(token.value)) {
        // Only the modelled observations may follow an identifier. An arbitrary property read is
        // opaque evaluation (a getter can do anything), and a `(` here would be a call.
        while (punctIs(".")) {
          cursor += 1;
          const property = peek();
          if (property?.kind !== "IDENT" || !scalarObservationProperty.test(property.value)) {
            return false;
          }
          cursor += 1;
        }
      }
      return true;
    }
    if (token.kind === "PUNCT" && token.value === "(") {
      cursor += 1;
      if (!parseTernary()) return false;
      if (!punctIs(")")) return false;
      cursor += 1;
      return true;
    }
    return false;
  };

  const parseUnary = (): boolean => {
    const token = peek();
    if (token?.kind === "PUNCT" && scalarUnaryOperators.has(token.value)) {
      cursor += 1;
      return parseUnary();
    }
    return parsePrimary();
  };

  const parseBinary = (): boolean => {
    if (!parseUnary()) return false;
    for (;;) {
      const token = peek();
      if (token?.kind !== "PUNCT" || !scalarBinaryOperators.has(token.value)) return true;
      cursor += 1;
      if (!parseUnary()) return false;
    }
  };

  function parseTernary(): boolean {
    if (!parseBinary()) return false;
    if (!punctIs("?")) return true;
    cursor += 1;
    if (!parseTernary()) return false;
    if (!punctIs(":")) return false;
    cursor += 1;
    return parseTernary();
  }

  if (!parseTernary()) return false;
  // Leftover tokens mean the grammar explained only a PREFIX of the expression. A partially
  // explained expression is not a proof about the whole expression.
  return cursor === tokens.length;
};

/**
 * Whether the COMPLETE expression is positively proven effect-free under the bounded grammar.
 * Exported so callers that need whole-region purity (concern coverage, authorization coverage,
 * typed-flow unit honesty) share one proof rather than re-deriving weaker approximations.
 */
export const isProvenEffectFreeScalarExpression = (expression: string): boolean => {
  const trimmed = expression.trim();
  if (trimmed === "") return false;
  const tokens = tokenizeScalarExpression(trimmed);
  if (tokens === null || tokens.length === 0) return false;
  return parseEffectFreeScalar(tokens);
};

const isLocalScalarExpression = (expression: string): boolean =>
  isProvenEffectFreeScalarExpression(expression);

/**
 * Proves that the COMPLETE statement is one bounded local observation of a named value.
 *
 * This is a WHOLE-UNIT scope-coverage fact, and it is deliberately NOT the weaker fact that every
 * occurrence of `name` is understood. Those two are permanently separate claims (RC2):
 *
 *   FLOW USE COMPLETENESS    every relevant use of `p` was enumerated and classified
 *   UNIT DISCOVERY COVERAGE  every material behavior in this changed unit is accounted for
 *
 * A statement such as `p.length > 0 && (enabled = 1)` may satisfy the first — every use of `p` is
 * a length observation — while the second is false, because the sibling region mutates state. FULL
 * unit coverage therefore requires the entire expression to be proven effect-free, not merely the
 * sub-regions that mention `name`.
 */
export const isFullyCoveredLocalObservation = (statement: string, name: string): boolean => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const binding = extractSimpleLocalBinding(normalized);
  if (
    binding?.declared &&
    identifierOccursIn(binding.expression, name) &&
    isProvenEffectFreeScalarExpression(binding.expression)
  ) {
    return true;
  }
  const control = normalized.match(/^\s*(?:if|while)\s*\(([\s\S]*)\)\s*\{?\s*$/u)?.[1];
  return (
    control !== undefined &&
    identifierOccursIn(control, name) &&
    isProvenEffectFreeScalarExpression(control)
  );
};

export const isFixedArgumentInvocation = (statement: string): boolean => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const binding = extractSimpleLocalBinding(normalized);
  const expression = binding?.declared ? binding.expression : normalized;
  if (
    !/^(?:return\s+)?(?:await\s+)?(?:new\s+)?[A-Za-z_$][\w$]*(?:\s*(?:\.|::|->)\s*[A-Za-z_$][\w$]*)*\s*\([\s\S]*\)$/u.test(
      expression,
    )
  ) {
    return false;
  }
  const sites = extractLocalCallSites(expression);
  if (sites.length !== 1) return false;
  const inspection = inspectQuotedRegions(expression);
  return (
    !inspection.unbalanced &&
    !inspection.regions.some((region) => region.interpolating) &&
    sites.every(
      (site) =>
        site.arguments.length === 0 ||
        site.arguments.every((argument) => isFixedLiteralExpression(argument)),
    )
  );
};

/**
 * Classifies changed local statement syntax. The class is metadata, not automatically a
 * promotion-grade absence proof: callers must consult establishesPromotionAbsence with the exact
 * statement and change direction.
 * In particular, FIXED_ARGUMENT_INVOCATION establishes only syntactically fixed arguments; the
 * callee/action remains arbitrary behavior. Unknown calls/data, branches, stores, policy/config
 * entries and wrapper provenance deliberately return null so discovery inadequacy remains explicit.
 */
export const classifyBoundedDiscoveryStatement = (
  statement: string,
  language: DeclarationLanguage,
): BoundedDiscoveryStatementClass | null => {
  if (isFixedDataDeclaration(statement, language)) return "FIXED_DATA_DECLARATION";
  if (declarationOnlyImport(statement, language)) return "DECLARATION_ONLY_IMPORT";
  const binding = extractSimpleLocalBinding(statement);
  if (language === "TS_JS" && binding?.declared && isLocalScalarExpression(binding.expression)) {
    return "LOCAL_SCALAR_COMPUTATION";
  }
  if (isFixedArgumentInvocation(statement)) return "FIXED_ARGUMENT_INVOCATION";
  return null;
};

const fixedDataExpression = (statement: string): { left: string; expression: string } | null => {
  const normalized = statement.trim().replace(/;\s*$/u, "");
  const assignment = topLevelAssignment(normalized);
  if (assignment < 0) return null;
  return {
    left: normalized.slice(0, assignment).trim(),
    expression: normalized.slice(assignment + 1).trim(),
  };
};

const plainNumericDeclaration = (statement: string, language: DeclarationLanguage): boolean => {
  const parts = fixedDataExpression(statement);
  if (parts === null) return false;
  const provenDeclaration = (() => {
    switch (language) {
      case "TS_JS":
        return /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*(?:\s*:\s*.+)?$/u.test(parts.left);
      case "PYTHON":
        return /^[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(parts.left);
      case "GO":
        return (
          /^const\s+[A-Za-z_][\w]*(?:\s+[^=]+)?$/u.test(parts.left) ||
          /^[A-Za-z_][\w]*\s*:\s*$/u.test(parts.left)
        );
      case "RUST":
        return /^(?:pub\s+)?const\s+[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(parts.left);
      case "KOTLIN":
        return /^(?:(?:public|private|protected|internal)\s+)*const\s+val\s+[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(
          parts.left,
        );
      case "SWIFT":
        return /^(?:(?:public|private|fileprivate|internal|open|static|class)\s+)*let\s+[A-Za-z_][\w]*(?:\s*:\s*.+)?$/u.test(
          parts.left,
        );
      case "OTHER":
        return false;
    }
  })();
  return (
    provenDeclaration &&
    /^[-+]?(?:0[xob][0-9a-f](?:_?[0-9a-f])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?)n?$/iu.test(
      parts.expression,
    )
  );
};

const scalarExpressionHasNoTextualPayload = (statement: string): boolean => {
  const binding = extractSimpleLocalBinding(statement.trim().replace(/;\s*$/u, ""));
  if (!binding?.declared) return false;
  const inspection = inspectQuotedRegions(binding.expression);
  return !inspection.unbalanced && inspection.regions.length === 0;
};

/**
 * Separates a bounded syntax label from authority to establish promotion-grade absence.
 *
 * - fixed data promotes only for a newly added plain numeric constant;
 * - local scalar computation promotes only for a newly added, local, unquoted scalar expression;
 * - erased/name-resolution-only imports may promote in either direction;
 * - a fixed-argument invocation is metadata only.
 *
 * Removed executable data/computation never receives absence authority from its old syntax alone.
 */
export const establishesPromotionAbsence = (
  statement: string,
  classification: BoundedDiscoveryStatementClass,
  changeKind: "ADDED" | "REMOVED" | "UNINSPECTABLE",
  language: DeclarationLanguage,
): boolean => {
  if (classification === "DECLARATION_ONLY_IMPORT") return true;
  if (changeKind !== "ADDED") return false;
  if (classification === "FIXED_DATA_DECLARATION") {
    return plainNumericDeclaration(statement, language);
  }
  if (classification === "LOCAL_SCALAR_COMPUTATION") {
    return language === "TS_JS" && scalarExpressionHasNoTextualPayload(statement);
  }
  return false;
};
