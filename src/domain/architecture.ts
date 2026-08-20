import path from "node:path";
import { parseFilePatches } from "./diff-parse";

/**
 * M7B architecture governance checker: a deterministic layering rule over the diff, not a model's
 * opinion of "good design". The rule follows the module convention M2 already derives
 * (module = `src/<layer>`): `src/domain` is the innermost layer — it defines the contracts and
 * invariants everything else builds on — so a domain file importing outward (into
 * `src/application`, `src/infrastructure`, or anywhere else under `src/` outside `src/domain`)
 * inverts the dependency direction and is a FAIL. Non-relative (package/builtin) imports are
 * unaffected; layers above domain may depend downward freely (that direction is legitimate).
 */

export interface ArchitectureGovernanceResult {
  state: "PASS" | "FAIL";
  evidence: string[];
  /** One human-readable description per layering violation found in the diff. */
  violations: string[];
}

const sourceFilePattern = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const DOMAIN_ROOT = "src/domain";

const isDomainFile = (file: string): boolean => file.startsWith(`${DOMAIN_ROOT}/`);

/**
 * Resolves a relative import specifier against its importing file, posix-style, and returns the
 * repository-relative target directory it points into — undefined for non-relative specifiers
 * (packages/builtins, which the layering rule does not constrain).
 */
const resolveSpecifierDir = (fromFile: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return base.startsWith("/") ? base.slice(1) : base;
};

/**
 * True for lines that cannot introduce an import: comment forms (`//`, `/*`, `*`, `#`). Skipped so
 * prose like `// moved here from "../application/x"` cannot fabricate a violation.
 */
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line);

/**
 * Extracts every import specifier on an added source line: `import ... from "x"`, side-effect
 * `import "x"`, dynamic `import("x")`, and `require("x")` — the side-effect and require forms are
 * exactly how a layering violation hides without a `from` clause.
 */
const specifiersOn = (line: string): string[] =>
  isCommentLine(line)
    ? []
    : [...line.matchAll(/(?:from\s+|import\s*\(?\s*|require\s*\()["']([^"']+)["']/gu)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier));

/**
 * Checks the diff for layering violations introduced by its added lines. Only *added* imports can
 * introduce a new violation; removed lines can only fix one, so they are not analyzed. Returns FAIL
 * with one violation description per offending import, or PASS with evidence of what was checked.
 */
export const deriveArchitectureGovernance = (patch: string): ArchitectureGovernanceResult => {
  const violations: string[] = [];
  let domainImportsChecked = 0;
  for (const entry of parseFilePatches(patch)) {
    if (!sourceFilePattern.test(entry.file) || !isDomainFile(entry.file)) continue;
    for (const line of entry.addedLines) {
      for (const specifier of specifiersOn(line)) {
        const resolved = resolveSpecifierDir(entry.file, specifier);
        if (resolved === undefined) continue;
        domainImportsChecked += 1;
        if (!resolved.startsWith(`${DOMAIN_ROOT}/`) && resolved !== DOMAIN_ROOT) {
          violations.push(
            `${entry.file} adds an import of "${specifier}" resolving to ${resolved}, outside ${DOMAIN_ROOT} — the domain layer must not depend on outer layers`,
          );
        }
      }
    }
  }
  if (violations.length > 0) {
    return { state: "FAIL", evidence: violations.slice(0, 10), violations };
  }
  return {
    state: "PASS",
    evidence: [
      domainImportsChecked > 0
        ? `${domainImportsChecked} added import(s) in src/domain files were resolved and all stayed within the domain layer`
        : "the diff adds no imports in src/domain files, so no layering violation can be introduced",
    ],
    violations,
  };
};
