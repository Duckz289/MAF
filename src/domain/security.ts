import { decodeGitPath, parseFilePatches } from "./diff-parse";

/**
 * M8A security checker: a deterministic credential-leak scan over the diff's added lines — not a
 * model's opinion of "is this secure". The one thing a diff can prove deterministically is that
 * new code/config text matches the shape of a leaked secret. Findings are always REDACTED in
 * evidence (prefix + "…redacted"): the harness must never copy a detected secret into its own
 * event stream, where it would live forever.
 */

export interface SecurityPostureResult {
  state: "PASS" | "WARN" | "FAIL" | "NOT_CHECKED";
  evidence: string[];
  /** One redacted description per finding. Never contains the matched value. */
  findings: string[];
}

interface StructuredPattern {
  name: string;
  pattern: RegExp;
}

const privateKeyLabelPatternSource =
  "(?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY(?: BLOCK)?";

// Secret formats with a structural signature — a match here is not a style opinion, it is the
// shape of a real credential. Word-bounded so surrounding prose cannot fragment-match.
const structuredPatterns: StructuredPattern[] = [
  { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  {
    name: "private key block",
    pattern: new RegExp(`-----BEGIN ${privateKeyLabelPatternSource}-----`, "u"),
  },
];

// A literal (quoted) value assigned to a credential-shaped name. The name list includes common
// snake/kebab/camel variants (`client_secret`, `clientSecret`, `refresh-token`) without accepting
// arbitrary words that merely contain "token" (for example `tokenizer`). Weaker than a structural
// match — `const token = "abc123def456"` may be a fixture dummy — so it never FAILs on its own.
const credentialCorePatternSource = `(?:password|passwd|secret|token|api[_.-]?key|access[_.-]?key|auth(?:entication)?[_.-]?token|client[_.-]?secret|refresh[_.-]?token|id[_.-]?token|private[_.-]?key)`;
// Environment and structured-config names commonly namespace credentials (`OPENAI_API_KEY`,
// `DATABASE_PASSWORD`, `AWS_SECRET_ACCESS_KEY`). Prefixes must be separator-delimited so an
// unrelated identifier such as `tokenizer` does not become credential-shaped. A small suffix set
// covers the established SECRET_ACCESS_KEY family without accepting arbitrary trailing words.
const credentialNamePatternSource = `(?:(?:[A-Za-z0-9]+[_.-]+)*${credentialCorePatternSource}(?:[_.-]+(?:access[_.-]+key|key|value|credential))?|[A-Za-z0-9]*${credentialCorePatternSource})`;
const genericCredentialPatternSource = String.raw`\b${credentialNamePatternSource}\b["']?\s*(?::=|[:=])\s*["'\x60]([^"'\x60\r\n]{8,})["'\x60]`;

// The unquoted `key=value` / `key: value` form — the generic pattern's quoted form never matches
// it, yet .env/yaml (the file types where literal credentials actually live) never quote. The
// value charset excludes code punctuation so a source expression like `token = crypto.randomUUID()`
// cannot match; placeholder/reference values are filtered by the caller.
const envCredentialPattern = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+|-[ \t]*)?${credentialNamePatternSource}[ \t]*[:=][ \t]*([^"'#\s(){}[\],;]{8,})[ \t]*(?:#.*)?$`,
  "iu",
);
const yamlCredentialBlockHeaderPattern = new RegExp(
  String.raw`^[ \t]*(?:-[ \t]*)?${credentialNamePatternSource}[ \t]*:[ \t]*[|>][+-]?[0-9]*[ \t]*(?:#.*)?$`,
  "iu",
);

// Values that are references or placeholders, not literals worth reporting.
const placeholderPattern =
  /^(?:x{3,}|\*{3,}|\$\{|\{\{|<|process\.env\.|changeme$|placeholder$|redacted$|your[_-]?[a-z]+$)/iu;

const testFilePattern = /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__|fixtures?)\//iu;

const redact = (value: string): string => `${value.slice(0, 3)}…(redacted)`;

// Key/value shapes recognized by redactSensitiveData (the event-stream redactor, below) —
// secret-shaped keys redact wholesale; bearer/secret prefixes inside strings redact in place.
const secretKeyPattern = /(api[-_]?key|secret|token|authorization|password|credential)/iu;
const secretValuePatternSource = String.raw`(Bearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,})`;

const structuredSecretPatternSource = structuredPatterns
  .map(({ pattern }) => pattern.source)
  .join("|");
const structuredSecretPattern = new RegExp(structuredSecretPatternSource, "u");

const redactPrivateKeyBlocks = (value: string): string =>
  value.replace(
    new RegExp(
      `-----BEGIN (${privateKeyLabelPatternSource})-----[\\s\\S]*?(?:-----END \\1-----|$)`,
      "gu",
    ),
    "[REDACTED PRIVATE KEY]",
  );

const redactStructuredSecrets = (value: string): string =>
  value.replace(new RegExp(structuredSecretPatternSource, "gu"), (match) => redact(match));

const redactPrefixedSecrets = (value: string): string =>
  value.replace(new RegExp(secretValuePatternSource, "giu"), "[REDACTED]");

const redactCredentialAssignments = (value: string): string => {
  let yamlBlockIndent: number | undefined;
  return value
    .split(/\r?\n/u)
    .map((line) => {
      if (yamlBlockIndent !== undefined && line.trim().length > 0) {
        const indentation = line.match(/^[ \t]*/u)?.[0] ?? "";
        if (indentation.length > yamlBlockIndent) return `${indentation}[REDACTED]`;
        yamlBlockIndent = undefined;
      }
      const quotedRedacted = line.replace(
        new RegExp(genericCredentialPatternSource, "giu"),
        (match, literal: string) =>
          placeholderPattern.test(literal) ? match : match.replace(literal, "[REDACTED]"),
      );
      if (yamlCredentialBlockHeaderPattern.test(quotedRedacted)) {
        yamlBlockIndent = (quotedRedacted.match(/^[ \t]*/u)?.[0] ?? "").length;
        return quotedRedacted;
      }
      const env = quotedRedacted.match(envCredentialPattern);
      const literal = env?.[1];
      return literal !== undefined && !placeholderPattern.test(literal)
        ? quotedRedacted.replace(literal, "[REDACTED]")
        : quotedRedacted;
    })
    .join("\n");
};

interface CredentialAssignment {
  matched: string;
  literal: string;
}

const credentialAssignments = (line: string): CredentialAssignment[] => {
  const quoted = [...line.matchAll(new RegExp(genericCredentialPatternSource, "giu"))].flatMap(
    (match) => (match[1] === undefined ? [] : [{ matched: match[0], literal: match[1] }]),
  );
  const env = line.match(envCredentialPattern);
  return env?.[1] === undefined ? quoted : [...quoted, { matched: env[0], literal: env[1] }];
};

const redactSensitiveString = (value: string): string =>
  redactCredentialAssignments(
    redactPrefixedSecrets(redactStructuredSecrets(redactPrivateKeyBlocks(value))),
  );

/** Credential references are opaque locators, never an escape hatch for a raw key. */
export const isSafeCredentialReference = (value: string): boolean =>
  /^credential:\/\/[A-Za-z0-9._~/-]+$/u.test(value) && redactSensitiveString(value) === value;

/** Sanitizes one untrusted string without applying metadata-key policy. */
export const redactSensitiveText = (value: string): string => redactSensitiveString(value);

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
  const safeReferenceValue =
    /references?$/iu.test(key) &&
    (typeof value === "string"
      ? isSafeCredentialReference(value)
      : Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && isSafeCredentialReference(entry)));
  const safeCapabilityValue =
    /capability$/iu.test(key) &&
    typeof value === "string" &&
    new Set(["REFERENCE_ONLY", "REDACTED", "PROXY_MEDIATED", "ISOLATED"]).has(value);
  if (
    secretKeyPattern.test(key) &&
    !safeReferenceValue &&
    !safeCapabilityValue &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) return value.map((child) => redactSensitiveData(child));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(value)) {
      // Define rather than assign so attacker-controlled keys such as `__proto__` remain inert
      // own data properties instead of invoking Object.prototype's legacy setter.
      Object.defineProperty(result, childKey, {
        value: redactSensitiveData(entry, childKey),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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
  if (yamlCredentialBlockHeaderPattern.test(line)) return true;
  return credentialAssignments(line).some(({ literal }) => !placeholderPattern.test(literal));
};

const REDACTED_PATCH_LINE =
  "+[redacted by the security checker: credential-shaped line suppressed]";
const REDACTED_BINARY_PATCH =
  "[redacted by the security checker: uninspectable binary patch payload suppressed]";
const binaryPatchMarkerPattern = /^(?:GIT binary patch|Binary files .+ differ)$/u;

/**
 * Redacts a diff preview before it is persisted as harness evidence. Files whose added lines
 * contain ANY credential-shaped content have every added line replaced by a marker — not just the
 * matched token — because a secret's surrounding material (a private key's base64 body, a
 * multi-line PEM block) carries no pattern of its own. Token-level redaction was reviewed and
 * found insufficient exactly there. Clean patches pass through byte-identical.
 */
export const redactPatchPreview = (patch: string): string => {
  const parsed = parseFilePatches(patch);
  const leakyFiles = new Set(
    parsed
      .filter((entry) => entry.addedLines.some((line) => lineHasCredentialContent(line)))
      .map((entry) => entry.file),
  );
  const binaryFiles = new Set(parsed.filter((entry) => entry.binary).map((entry) => entry.file));
  const hasUnattributedBinaryMarker = patch
    .split(/\r?\n/u)
    .some((line) => binaryPatchMarkerPattern.test(line));
  if (leakyFiles.size === 0 && binaryFiles.size === 0 && !hasUnattributedBinaryMarker) return patch;
  const header = (line: string, kind: "PLUS" | "MINUS"): { matched: boolean; file?: string } => {
    const quotedPath = String.raw`"((?:\\.|[^"])*)"`;
    const match = line.match(
      new RegExp(
        kind === "PLUS"
          ? String.raw`^\+\+\+\s+(?:${quotedPath}|\/dev\/null|((?:a|b)\/\S+))`
          : String.raw`^---\s+(?:${quotedPath}|\/dev\/null|((?:a|b)\/\S+))`,
        "u",
      ),
    );
    if (!match) return { matched: false };
    const file = decodeGitPath(match[1] ?? match[2] ?? "")
      .replace(/^(?:a|b)\//u, "")
      .replace(/\\/g, "/");
    return file && file !== "/dev/null" ? { matched: true, file } : { matched: true };
  };
  const output: string[] = [];
  const diffHeaderFile = (line: string): string | undefined => {
    const quotedPath = String.raw`"((?:\\.|[^"])*)"`;
    const match = line.match(
      new RegExp(
        String.raw`^diff --git (?:${quotedPath}|(a\/\S+)) (?:${quotedPath}|(b\/\S+))$`,
        "u",
      ),
    );
    const raw = match?.[3] ?? match?.[4] ?? match?.[1] ?? match?.[2];
    return raw === undefined
      ? undefined
      : decodeGitPath(raw)
          .replace(/^(?:a|b)\//u, "")
          .replace(/\\/g, "/");
  };
  let minusFile: string | undefined;
  let suppressingAddedLines = false;
  let suppressingBinary = false;
  let binaryMarkerWritten = false;
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      const file = diffHeaderFile(line);
      minusFile = undefined;
      suppressingAddedLines = false;
      suppressingBinary = file !== undefined && binaryFiles.has(file);
      binaryMarkerWritten = false;
      output.push(line);
      continue;
    }
    const minus = header(line, "MINUS");
    if (minus.matched) {
      minusFile = minus.file;
      suppressingAddedLines = false;
      suppressingBinary = false;
      binaryMarkerWritten = false;
      output.push(line);
      continue;
    }
    const plus = header(line, "PLUS");
    if (plus.matched) {
      const file = plus.file ?? minusFile;
      suppressingAddedLines = file !== undefined && leakyFiles.has(file);
      suppressingBinary = file !== undefined && binaryFiles.has(file);
      binaryMarkerWritten = false;
      output.push(line);
    } else if (binaryPatchMarkerPattern.test(line)) {
      // Fail closed even when a malformed or unusually quoted Git header prevented attribution.
      // Once a binary marker appears, its body is uninspectable until the next diff header.
      suppressingBinary = true;
      if (!binaryMarkerWritten) output.push(REDACTED_BINARY_PATCH);
      binaryMarkerWritten = true;
    } else if (suppressingBinary) {
      if (!binaryMarkerWritten) output.push(REDACTED_BINARY_PATCH);
      binaryMarkerWritten = true;
    } else if (suppressingAddedLines && line.startsWith("+")) {
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
  const parsed = parseFilePatches(patch);
  const findings: string[] = [];
  let structuredInProduction = false;
  let structuredInTests = false;
  let genericInProduction = false;
  let genericInTests = false;
  let addedLinesScanned = 0;
  const binaryFiles = parsed.filter((entry) => entry.binary).map((entry) => entry.file);
  const otherUninspectable = parsed
    .filter((entry) => (entry.uninspectableReasons ?? []).some((reason) => reason !== "BINARY"))
    .map((entry) => ({ file: entry.file, reasons: entry.uninspectableReasons ?? [] }));
  const hasUnattributedBinaryMarker = patch
    .split(/\r?\n/u)
    .some((line) => binaryPatchMarkerPattern.test(line));
  if (binaryFiles.length === 0 && hasUnattributedBinaryMarker) {
    binaryFiles.push("unknown file (Git header could not be attributed)");
  }

  for (const entry of parsed) {
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
      if (yamlCredentialBlockHeaderPattern.test(line)) {
        findings.push(`${entry.file} adds a credential-shaped YAML block scalar (value redacted)`);
        if (isTestFile) genericInTests = true;
        else genericInProduction = true;
      }
      for (const assignment of credentialAssignments(line)) {
        if (placeholderPattern.test(assignment.literal)) continue;
        findings.push(
          `${entry.file} assigns a literal value to credential-shaped name "${assignment.matched.split(/[:=]/u)[0]?.trim().replace(/["']/gu, "")}" (${redact(assignment.literal)})`,
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
  if (binaryFiles.length > 0) {
    evidence.push(
      `${binaryFiles.length} binary file diff(s) could not be inspected for credential content: ${binaryFiles.slice(0, 10).join(", ")}`,
    );
    evidence.push(
      `${addedLinesScanned} textual added line(s) scanned; binary payloads remain NOT_CHECKED`,
    );
    return { state: "NOT_CHECKED", evidence, findings };
  }
  if (otherUninspectable.length > 0) {
    evidence.push(
      `${otherUninspectable.length} Git change(s) do not expose complete destination bytes for credential inspection: ${otherUninspectable
        .slice(0, 10)
        .map(({ file, reasons }) => `${file} (${reasons.join("+")})`)
        .join(", ")}`,
    );
    evidence.push(
      `${addedLinesScanned} textual added line(s) scanned; unexposed destination content remains NOT_CHECKED`,
    );
    return { state: "NOT_CHECKED", evidence, findings };
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
