import { parseFilePatches } from "./diff-parse";

/**
 * M8A security checker: a deterministic credential-leak scan over the diff's added lines — not a
 * model's opinion of "is this secure". The one thing a diff can prove deterministically is that
 * new code/config text matches the shape of a leaked secret. Findings are always REDACTED in
 * evidence (prefix + "…redacted"): the harness must never copy a detected secret into its own
 * event stream, where it would live forever.
 */

export interface SecurityPostureResult {
  state: "PASS" | "WARN" | "FAIL";
  evidence: string[];
  /** One redacted description per finding. Never contains the matched value. */
  findings: string[];
}

interface StructuredPattern {
  name: string;
  pattern: RegExp;
}

// Secret formats with a structural signature — a match here is not a style opinion, it is the
// shape of a real credential. Word-bounded so surrounding prose cannot fragment-match.
const structuredPatterns: StructuredPattern[] = [
  { name: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/u,
  },
];

// A literal (quoted) value assigned to a credential-shaped name. Weaker than a structural match —
// `const token = "abc123def456"` may be a fixture dummy — so it never FAILs on its own.
const genericCredentialPattern =
  /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth(?:entication)?[_-]?token)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/iu;

// The unquoted `key=value` / `key: value` form — the generic pattern's quoted form never matches
// it, yet .env/yaml (the file types where literal credentials actually live) never quote. The
// value charset excludes code punctuation so a source expression like `token = crypto.randomUUID()`
// cannot match; placeholder/reference values are filtered by the caller.
const envCredentialPattern =
  /^[ \t]*[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]*[ \t]*[:=][ \t]*([^"'#\s(){}[\],;]{8,})[ \t]*$/iu;

// Values that are references or placeholders, not literals worth reporting.
const placeholderPattern =
  /^(?:x{3,}|\*{3,}|\$\{|\{\{|<|process\.env\.|changeme$|placeholder$|redacted$|your[_-]?[a-z]+$)/iu;

const testFilePattern = /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__|fixtures?)\//iu;

const redact = (value: string): string => `${value.slice(0, 3)}…(redacted)`;

// Key/value shapes recognized by redactSensitiveData (the event-stream redactor, below) —
// secret-shaped keys redact wholesale; bearer/secret prefixes inside strings redact in place.
const secretKeyPattern = /(api[-_]?key|secret|token|authorization|password|credential)/iu;
const secretValuePattern =
  /(Bearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,})/giu;

const structuredSecretPattern = new RegExp(
  structuredPatterns.map(({ pattern }) => pattern.source).join("|"),
  "gu",
);

/**
 * Redacts secrets wherever they appear in a value — the harness-side half of the redaction
 * invariant. Two layers: (1) key-based — a value stored under a secret-shaped key (token,
 * apiKey, credential, ...) is replaced wholesale with "[REDACTED]" unless the key marks it as a
 * reference/capability (the `credential://` reference is the thing we intentionally store);
 * (2) value-based — a string that contains a structured secret format (see the M8A patterns
 * above) has each match replaced with the redacted form, guarding the path where an untrusted
 * value (a diff preview, verifier output, an external hint) would otherwise be copied verbatim
 * into the run's event stream. A secret the harness never stored is a secret it can never leak.
 */
export const redactSensitiveData = (value: unknown, key = ""): unknown => {
  const safeMetadataKey = /(reference|references|capability)$/iu.test(key);
  if (
    secretKeyPattern.test(key) &&
    !safeMetadataKey &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const structurallyRedacted = value.replace(structuredSecretPattern, (match) => redact(match));
    return secretValuePattern.test(structurallyRedacted)
      ? structurallyRedacted.replace(secretValuePattern, "[REDACTED]")
      : structurallyRedacted;
  }
  if (Array.isArray(value)) return value.map((child) => redactSensitiveData(child));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(value)) {
      result[childKey] = redactSensitiveData(entry, childKey);
    }
    return result;
  }
  return value;
};

/**
 * True when an added line itself carries credential-shaped content: a structured secret format,
 * or a literal (quoted or env/yaml-style unquoted) assigned to a credential-shaped name with a
 * non-placeholder value. Used by {@link redactPatchPreview}, which must catch MORE than the
 * checker flags: a private key's base64 body has no per-line signature but follows a flagged
 * header line inside the same file, so whole-file suppression is the only safe granularity.
 */
const lineHasCredentialContent = (line: string): boolean => {
  if (structuredSecretPattern.test(line)) return true;
  const generic = line.match(genericCredentialPattern) ?? line.match(envCredentialPattern);
  const literal = generic?.[1];
  return literal !== undefined && !placeholderPattern.test(literal);
};

const REDACTED_PATCH_LINE =
  "+[redacted by the security checker: credential-shaped line suppressed]";

/**
 * Redacts a diff preview before it is persisted as harness evidence. Files whose added lines
 * contain ANY credential-shaped content have every added line replaced by a marker — not just the
 * matched token — because a secret's surrounding material (a private key's base64 body, a
 * multi-line PEM block) carries no pattern of its own. Token-level redaction was reviewed and
 * found insufficient exactly there. Clean patches pass through byte-identical.
 */
export const redactPatchPreview = (patch: string): string => {
  const leakyFiles = new Set(
    parseFilePatches(patch)
      .filter((entry) => entry.addedLines.some((line) => lineHasCredentialContent(line)))
      .map((entry) => entry.file),
  );
  if (leakyFiles.size === 0) return patch;
  const headerFile = (line: string): string | undefined => {
    const match = line.match(/^\+\+\+\s+(?:"([^"]+)"|\/dev\/null|(?:a|b)\/(\S+))/u);
    if (!match) return undefined;
    const file = (match[1] ?? match[2] ?? "").replace(/^(?:a|b)\//u, "").replace(/\\/g, "/");
    return file && file !== "/dev/null" ? file : undefined;
  };
  const output: string[] = [];
  let suppressing = false;
  for (const line of patch.split(/\r?\n/u)) {
    const file = headerFile(line);
    if (file !== undefined) {
      suppressing = leakyFiles.has(file);
      output.push(line);
    } else if (suppressing && line.startsWith("+")) {
      output.push(REDACTED_PATCH_LINE);
    } else {
      output.push(line);
    }
  }
  return output.join("\n");
};

/**
 * Scans the diff's added lines (all file types — secrets live in .env/yaml/json, not just source)
 * for credential patterns. Structural matches in production files FAIL; structural matches
 * confined to test/fixture files, or generic literal assignments in production files, WARN
 * (checked, flagged — worth attention, not proof of a leak); generic matches confined to
 * test/fixture files are disclosed but pass, because dummy credentials in tests are the norm and
 * must not deadlock every fixture. Removed lines are not scanned: deleting a secret is an
 * improvement, and the remainder of the file is outside this diff's evidence.
 */
export const deriveSecurityPosture = (patch: string): SecurityPostureResult => {
  const findings: string[] = [];
  let structuredInProduction = false;
  let structuredInTests = false;
  let genericInProduction = false;
  let genericInTests = false;
  let addedLinesScanned = 0;

  for (const entry of parseFilePatches(patch)) {
    const isTestFile = testFilePattern.test(entry.file);
    for (const line of entry.addedLines) {
      addedLinesScanned += 1;
      for (const { name, pattern } of structuredPatterns) {
        const match = line.match(pattern);
        if (match) {
          findings.push(`${entry.file} adds a ${name} (${redact(match[0])})`);
          if (isTestFile) structuredInTests = true;
          else structuredInProduction = true;
        }
      }
      const generic = line.match(genericCredentialPattern) ?? line.match(envCredentialPattern);
      if (generic?.[1] && !placeholderPattern.test(generic[1])) {
        findings.push(
          `${entry.file} assigns a literal value to credential-shaped name "${generic[0].split(/[:=]/u)[0]?.trim().replace(/["']/gu, "")}" (${redact(generic[1])})`,
        );
        if (isTestFile) genericInTests = true;
        else genericInProduction = true;
      }
    }
  }

  const evidence: string[] = [];
  if (structuredInProduction) {
    evidence.push(
      `${findings.length} credential-pattern finding(s) in production files; structured secret formats are deterministic evidence of a leak`,
    );
    return { state: "FAIL", evidence, findings };
  }
  if (structuredInTests || genericInProduction) {
    if (structuredInTests) {
      evidence.push(
        "structured secret-format match(es) confined to test/fixture files — flagged, not treated as a leak",
      );
    }
    if (genericInProduction) {
      evidence.push(
        "literal value(s) assigned to credential-shaped names in production files — flagged for review",
      );
    }
    evidence.push(`${findings.length} finding(s), none proving a leak`);
    return { state: "WARN", evidence, findings };
  }
  return {
    state: "PASS",
    evidence: [
      `no credential or secret patterns found in ${addedLinesScanned} added line(s) scanned${genericInTests ? ` (${findings.length} dummy credential(s) in test/fixture files, disclosed but not counted as findings)` : ""}`,
    ],
    findings: genericInTests ? findings : [],
  };
};
