import type { ConcernEvidence } from "./assurance-obligation";
import type { DiscoveredConcern } from "./concern-discovery";
import { deriveSecurityPosture } from "./security";
import { deriveSemanticSensitivity } from "./semantic-sensitivity";
import { parseFilePatches } from "./diff-parse";
import {
  directLocalCallExpression,
  declarationLanguageOf,
  directSourceCallArgumentsCovered,
  extractLocalCallSites,
  extractSimpleLocalBinding,
  identifierOccursIn,
  inspectQuotedRegions,
  splitLocalStatements,
  stripProvenPlainQuotedRegions,
} from "./local-code-semantics";

/**
 * Typed per-concern evidence production.
 *
 * Adversarial probing of the typed-concern layer found a composition failure: concern obligations
 * were resolved by reading the BROAD `report.Security` dimension. That dimension is a summary of
 * several different questions (credential literals, concealed-input flow, exposure pairing), so a
 * PASS produced by one scanner could discharge a concern only a different scanner addresses. That
 * is finding H1 re-emerging through a summary instead of through a registry entry.
 *
 * This module closes it by producing evidence that is ADDRESSED to a concern and STAMPED with its
 * producing capability and candidate binding. The obligation fold then resolves a concern only
 * from evidence bearing that concern's own name.
 *
 * What each producer may say is deliberately narrow, and the narrowness is the point:
 *
 * - the credential-literal scanner may speak about `SECURITY.CREDENTIAL_LITERAL` and nothing else,
 *   however clean its result;
 * - the semantic flow scanner may speak about concealed-input flow and environment-secret
 *   exposure, because those are the shapes it models;
 * - nothing may speak about authorization correctness or subprocess input provenance, because no
 *   checker in this build evaluates either. Those concerns therefore stay unresolved by
 *   construction rather than by a maintained exception list.
 *
 * A PASS here means "this capability looked for its own signal in material it can read and found
 * none". Whether that is ENOUGH is not decided here — coverage and evidence strength are applied
 * by the fold, so a producer cannot promote its own finding past its adequacy limits.
 */

export interface ConcernEvidenceInput {
  diffPatch: string;
  concerns: DiscoveredConcern[];
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
}

/** Credential-shaped naming, matching the discovery module's convention test. */
const sensitiveName =
  /\b[A-Za-z_][A-Za-z0-9_]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|auth[_-]?token|session[_-]?key|passphrase)[A-Za-z0-9_]*\b|\b(?:password|passwd|pwd|secret|token|apikey|credential|session[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?token|passphrase)\b/iu;

/**
 * Whether every later local use of a sensitive-origin value is classified as a known-local
 * observation.
 *
 * This is an allowlist only of facts the bounded local syntax can establish: length inspection,
 * equality/order comparison, and a value used directly as a local condition. Everything else is
 * UNKNOWN, including computed keys, container insertion, property/index writes, mutation, calls,
 * interpolation, return/yield/throw, and syntax the classifier does not recognise. Unknown and a
 * known escape have the same trust consequence: this capability emits no clean PASS.
 *
 * Aliases are propagated within the same changed file. Creating an alias is not itself called an
 * escape, but every later alias use must meet the same local-only rule. This is deliberately not
 * interprocedural or cross-file taint analysis.
 */
interface LocalUseCompletenessReport {
  completeness: "COMPLETE" | "INCOMPLETE";
  coverage: "FULL" | "PARTIAL";
  analysisScope: string;
  evidence: string[];
}

const identifierPattern = (name: string, flags = "u"): RegExp =>
  new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, flags);

const quotedRegionsHideIdentifier = (statement: string, name: string): boolean => {
  const inspection = inspectQuotedRegions(statement);
  if (inspection.unbalanced) return true;
  return inspection.regions.some(
    (region) => region.interpolating && identifierOccursIn(region.content, name),
  );
};

const directSensitiveSourceExpression = (expression: string, file: string): boolean => {
  const normalized = expression
    .trim()
    .replace(/^await\s+/iu, "")
    .trim();
  const directCall = directLocalCallExpression(normalized);
  if (directCall !== null) {
    return (
      (concealedSourceOn(directCall.callee) || environmentSourceOn(normalized)) &&
      directSourceCallArgumentsCovered(directCall, declarationLanguageOf(file))
    );
  }
  // Direct namespace/property reads are modelled; composed expressions are not.
  return (
    environmentSourceOn(normalized) &&
    /^[A-Za-z_$][\w$]*(?:(?:\.|::|->)\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*$/u.test(normalized)
  );
};

/**
 * Enumerates the complete bounded proof tuple: origin → direct local binding → every later binding
 * use → classification. Failure at any stage is INCOMPLETE, not detector silence and never PASS.
 *
 * Enumeration is not "every identifier occurrence the scanner happened to notice after stripping
 * all quotes". Proven-plain literals may be ignored; expansion-capable quoted regions, `$name`
 * forms, and unbalanced quotes are uses or holes. If a later statement cannot be proven free of
 * the binding, the tuple is incomplete.
 */
const analyzeLocalUseCompleteness = (
  patch: string,
  relevantFiles?: ReadonlySet<string>,
): LocalUseCompletenessReport => {
  let originsIdentified = 0;
  let originBindingsEnumerated = 0;
  let usesEnumerated = 0;
  let usesClassified = 0;
  const incompleteReasons: string[] = [];

  for (const entry of parseFilePatches(patch)) {
    if (relevantFiles !== undefined && !relevantFiles.has(entry.file)) continue;
    const sensitiveBindings = new Set<string>();
    for (const raw of splitLocalStatements(entry.addedLines)) {
      const line = raw.trim();
      if (line === "" || /^\s*(?:\/\/|#|--|\*|;|\/\*)/u.test(line)) continue;
      if (inspectQuotedRegions(line).unbalanced) {
        incompleteReasons.push(
          `${entry.file}: a quoted/template region is unbalanced, so local uses cannot be completely enumerated`,
        );
      }
      const binding = extractSimpleLocalBinding(line);
      const sourceInStatement = concealedSourceOn(line) || environmentSourceOn(line);
      const namedSensitiveBinding = binding !== null && sensitiveName.test(binding.name);

      // Classify uses of every binding already in scope before adding a new origin. This prevents
      // a new source declaration from hiding an older sensitive value passed as one of its inputs.
      for (const name of [...sensitiveBindings]) {
        const identifier = identifierPattern(name);
        const quoted = inspectQuotedRegions(line);
        if (quoted.unbalanced) {
          usesEnumerated += 1;
          incompleteReasons.push(
            `${entry.file}: ${name} cannot be enumerated because a quoted/template region is unbalanced`,
          );
          continue;
        }
        if (quotedRegionsHideIdentifier(line, name)) {
          usesEnumerated += 1;
          incompleteReasons.push(
            `${entry.file}: ${name} appears in an expansion-capable quoted/template region; stripping that region would hide the use`,
          );
          continue;
        }
        // Ordinary proven-plain quoted text that happens to equal the identifier is not a use.
        const code = stripProvenPlainQuotedRegions(line);
        if (!identifierOccursIn(code, name)) continue;
        usesEnumerated += 1;

        const alias = extractSimpleLocalBinding(code);
        if (alias !== null && alias.expression === name && alias.name !== name) {
          sensitiveBindings.add(alias.name);
          usesClassified += 1;
          continue;
        }

        // A sensitive identifier in any non-control call argument leaves the local observation
        // boundary. This includes container insertion APIs and unfamiliar helpers.
        const passedToCall = extractLocalCallSites(code).some((site) => {
          const callee = site.callee
            .split(/\s*(?:\.|::|->)\s*/u)
            .at(-1)
            ?.toLowerCase();
          if (callee === "if" || callee === "while" || callee === "switch") return false;
          return site.arguments.some((argument) => identifier.test(argument));
        });
        if (passedToCall) {
          incompleteReasons.push(
            `${entry.file}: ${name} is passed to a call outside local observation`,
          );
          continue;
        }

        // Computed-key/index use and container literals are not local observation. A property or
        // index on either side of an assignment is a write/alias/mutation boundary.
        if (new RegExp(`\\[[^\\]]*${identifier.source}[^\\]]*\\]`, "u").test(code)) {
          incompleteReasons.push(`${entry.file}: ${name} is used as a computed key/index`);
          continue;
        }
        if (
          new RegExp(`${identifier.source}\\s*(?:\\.\\s*\\w+|\\[[^\\]]*\\])\\s*=`, "u").test(code)
        ) {
          incompleteReasons.push(`${entry.file}: ${name} participates in a property/index write`);
          continue;
        }
        if (
          new RegExp(
            `(?:\\+\\+|--)\\s*${identifier.source}|${identifier.source}\\s*(?:\\+\\+|--)`,
            "u",
          ).test(code)
        ) {
          incompleteReasons.push(`${entry.file}: ${name} is mutated`);
          continue;
        }
        if (
          new RegExp(
            `\\b(?:return|yield|throw|raise)\\s+${identifier.source}\\s*;?\\s*$`,
            "u",
          ).test(code)
        ) {
          incompleteReasons.push(
            `${entry.file}: ${name} leaves the local scope through control flow`,
          );
          continue;
        }

        const assignment = code.match(/^(.*?)\s*(?::=|(?<![=!<>])=(?!=))\s*(.*)$/su);
        if (assignment?.[1] !== undefined && assignment[2] !== undefined) {
          const left = assignment[1];
          const right = assignment[2];
          if (identifier.test(left)) {
            incompleteReasons.push(`${entry.file}: ${name} is assigned or stored`);
            continue;
          }
          if (identifier.test(right)) {
            const localObservation = knownLocalObservation(right, name);
            if (!localObservation) {
              incompleteReasons.push(
                `${entry.file}: ${name} is used in an unclassified assignment expression`,
              );
              continue;
            }
            usesClassified += 1;
            continue;
          }
        }

        if (!knownLocalObservation(code, name)) {
          incompleteReasons.push(`${entry.file}: ${name} has an unclassified local use`);
          continue;
        }
        usesClassified += 1;
      }

      if (sourceInStatement || namedSensitiveBinding) {
        originsIdentified += 1;
        if (
          binding === null ||
          (sourceInStatement && !directSensitiveSourceExpression(binding.expression, entry.file))
        ) {
          incompleteReasons.push(
            `${entry.file}: a sensitive origin is not represented as one direct simple local binding`,
          );
          continue;
        }
        originBindingsEnumerated += 1;
        sensitiveBindings.add(binding.name);
      }
    }
  }

  if (originsIdentified === 0) {
    incompleteReasons.push(
      "no sensitive origin/binding could be enumerated for the raised flow concern",
    );
  }
  if (originBindingsEnumerated !== originsIdentified) {
    incompleteReasons.push(
      `${originsIdentified - originBindingsEnumerated} sensitive origin(s) lacked a completely enumerated direct local binding`,
    );
  }
  if (usesClassified !== usesEnumerated) {
    incompleteReasons.push(
      `${usesEnumerated - usesClassified} enumerated sensitive-binding use(s) were not proven known-local`,
    );
  }
  const complete =
    originsIdentified > 0 &&
    originBindingsEnumerated === originsIdentified &&
    usesClassified === usesEnumerated &&
    incompleteReasons.length === 0;
  return {
    completeness: complete ? "COMPLETE" : "INCOMPLETE",
    coverage: complete ? "FULL" : "PARTIAL",
    analysisScope:
      "IDENTIFIER-USE COMPLETENESS ONLY: direct sensitive origins and every later identifier use of those bindings in changed local statements. This is NOT whole-unit behavioral coverage — a statement may have every use of the tracked value classified while a sibling region of that same statement remains unaccounted, which DISCOVERY.ADEQUACY owns. No interprocedural, cross-file, or unchanged-code claim.",
    evidence: [
      `local completeness tuple: origins identified ${originsIdentified}, origin bindings enumerated ${originBindingsEnumerated}, uses enumerated ${usesEnumerated}, uses classified ${usesClassified}`,
      ...(complete
        ? ["every enumerated use was classified as a known-local observation"]
        : incompleteReasons.slice(0, 12)),
    ],
  };
};

const knownLocalObservation = (code: string, name: string): boolean => {
  const identifier = identifierPattern(name);
  let remaining = code;
  // Property observation is deliberately narrow. Calling a method on the value is UNKNOWN: the
  // scanner has no type information with which to prove that method pure or non-escaping.
  remaining = remaining.replace(new RegExp(`${identifier.source}\\s*\\.\\s*length\\b`, "gu"), "0");
  remaining = remaining.replace(
    new RegExp(`${identifier.source}\\s*(?:(?:===?|!==?|<=|>=|<|>)\\s*[^&|?:;,)}]+)`, "gu"),
    "true",
  );
  remaining = remaining.replace(
    new RegExp(`[^&|?:;,{(]+\\s*(?:===?|!==?|<=|>=|<|>)\\s*${identifier.source}`, "gu"),
    "true",
  );
  if (!identifier.test(remaining)) return true;
  // Direct truthiness in a local branch/loop is an observation; the earlier call, assignment,
  // computed-key, mutation and propagation checks ensure the same statement does not also pass it
  // onward.
  return new RegExp(
    `^\\s*(?:if|while)\\s*\\([^)]*${identifier.source}[^)]*\\)\\s*\\{?\\s*$`,
    "u",
  ).test(remaining);
};

const concealedSourceOn = (line: string): boolean =>
  /\b(?:getpass|read[_\s]*password|hidden[_\s]*input|no[_\s]*echo|prompt[_\s]*(?:for[_\s]*)?password)\b/iu.test(
    line,
  );

const environmentSourceOn = (line: string): boolean =>
  /\b(?:process\s*\.\s*env|env|getenv|ENV)\b/iu.test(line);

/**
 * Produces typed evidence for exactly the concerns this build's capabilities can address.
 *
 * Concerns nothing addresses (authorization behaviour, subprocess input provenance) intentionally
 * receive no record at all: absence of a record is what makes the fold report NOT_CHECKED, which
 * is the honest statement — no capability looked, so nothing was established.
 */
export const deriveConcernEvidence = (input: ConcernEvidenceInput): ConcernEvidence[] => {
  const raised = new Set(input.concerns.map((concern) => concern.concern));
  if (raised.size === 0) return [];
  const binding = {
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.diffDigest !== undefined ? { diffDigest: input.diffDigest } : {}),
  };
  const evidence: ConcernEvidence[] = [];

  if (raised.has("SECURITY.CREDENTIAL_LITERAL")) {
    const posture = deriveSecurityPosture(input.diffPatch);
    const analysis = posture.credentialLiteralAnalysis;
    const obligationAtoms = new Set(
      input.concerns
        .filter((concern) => concern.concern === "SECURITY.CREDENTIAL_LITERAL")
        .flatMap((concern) => concern.obligationAtomIdentities),
    );
    const analyzed = new Map(
      analysis.analyzedAtoms.map((atom) => [atom.atomIdentity, atom.decision] as const),
    );
    const undecided = new Set(analysis.undecidedAtoms.map((atom) => atom.atomIdentity));
    const missing = [...obligationAtoms].filter(
      (atom) => !analyzed.has(atom) && !undecided.has(atom),
    );
    const undecidedObligations = [...obligationAtoms].filter((atom) => undecided.has(atom));
    const flagged = [...obligationAtoms].filter((atom) => analyzed.get(atom) === "FLAGGED_LITERAL");
    const domainComplete =
      posture.state !== "NOT_CHECKED" &&
      missing.length === 0 &&
      undecidedObligations.length === 0 &&
      obligationAtoms.size > 0;
    const outcome =
      posture.state === "FAIL"
        ? "FAIL"
        : flagged.length > 0
          ? "WARN"
          : domainComplete
            ? "PASS"
            : "NOT_CHECKED";
    evidence.push({
      concern: "SECURITY.CREDENTIAL_LITERAL",
      producedBy: "SECURITY.CREDENTIAL_LITERAL_SCAN",
      outcome,
      claim:
        outcome === "PASS"
          ? "NEGATIVE_ABSENCE"
          : outcome === "NOT_CHECKED"
            ? "NEGATIVE_ABSENCE"
            : "POSITIVE_FINDING",
      completeness:
        outcome === "PASS"
          ? "COMPLETE"
          : outcome === "NOT_CHECKED"
            ? "INCOMPLETE"
            : "NOT_APPLICABLE",
      coverage: outcome === "NOT_CHECKED" ? "PARTIAL" : "FULL",
      strength: "STRUCTURAL",
      analysisScope: `${analysis.predicateId}: producer-owned decisions for ${obligationAtoms.size} exact raw changed atom(s) that raised the credential-literal obligation`,
      evidence: [
        `credential-literal producer: posture=${posture.state}, predicate=${analysis.predicateId}, obligations=${obligationAtoms.size}, analyzed=${analysis.analyzedAtoms.length}, undecided=${analysis.undecidedAtoms.length}`,
        ...posture.evidence,
        ...posture.findings,
        ...(missing.length > 0
          ? [`${missing.length} obligated atom(s) were absent from the producer's declared domain`]
          : []),
        ...(undecidedObligations.length > 0
          ? [
              `${undecidedObligations.length} obligated atom(s) remain interpolation-capable and undecided`,
            ]
          : []),
      ],
      ...binding,
    });
  }

  const flowConcerns = ["SECURITY.SENSITIVE_INPUT_FLOW", "SECURITY.ENV_SECRET_EXPOSURE"] as const;
  if (flowConcerns.some((concern) => raised.has(concern))) {
    // Typed concern evidence is scoped to the files that actually raised this concern family. An
    // unrelated unsupported sibling must remain visible through DISCOVERY.ADEQUACY, but it must
    // not repaint a completely analyzed typed concern as unsupported.
    const flowConcernFiles = new Set(
      input.concerns
        .filter((item) => flowConcerns.includes(item.concern as (typeof flowConcerns)[number]))
        .map((item) => item.file),
    );
    const semantic = deriveSemanticSensitivity(input.diffPatch, flowConcernFiles);
    const flagged = semantic.exposurePairs.length > 0;
    // Whether the sensitive value is PASSED ANYWHERE at all, beyond the line that binds it.
    //
    // This distinction is the correction to a false-safe found by adversarial probing. Previously
    // any absence of a modelled source→sink pair produced a clean PASS, so a secret handed to an
    // unfamiliar helper (`sendToAnalytics(password)`) resolved the concern: the concern was raised
    // by one detector and cleared by a narrower one that only knows the sinks it models.
    //
    // A capability may only report a clean result for what it can actually establish. It CAN
    // establish "this value is never passed to anything" — that is a local, syntactic fact it
    // reads completely. It CANNOT establish "every function this value reaches is safe". So:
    //
    //   - value flows into a modelled sink        → WARN (flagged)
    //   - value is passed to something unmodelled → no evidence (obligation stays NOT_CHECKED)
    //   - value is never passed anywhere          → PASS (a real, checkable observation)
    //
    // The third case is what keeps this progressive rather than a blanket block: the common,
    // genuinely-fine shape still resolves.
    const localUse = analyzeLocalUseCompleteness(input.diffPatch, flowConcernFiles);
    const negativeComplete =
      localUse.completeness === "COMPLETE" &&
      (semantic.coverage === "FULL" || semantic.coverage === "NOT_APPLICABLE");
    for (const concern of flowConcerns) {
      if (!raised.has(concern)) continue;
      if (flagged) {
        evidence.push({
          concern,
          producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
          outcome: "WARN",
          claim: "POSITIVE_FINDING",
          completeness: "NOT_APPLICABLE",
          coverage: semantic.coverage,
          strength: "STRUCTURAL",
          analysisScope: localUse.analysisScope,
          evidence: [
            `semantic flow scan flagged ${semantic.exposurePairs.length} source→sink pair(s) relevant to ${concern}`,
            ...semantic.evidence,
            ...localUse.evidence,
          ],
          ...binding,
        });
        continue;
      }
      if (negativeComplete) {
        evidence.push({
          concern,
          producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
          outcome: "PASS",
          claim: "NEGATIVE_ABSENCE",
          completeness: "COMPLETE",
          coverage: semantic.coverage,
          strength: "STRUCTURAL",
          analysisScope: localUse.analysisScope,
          evidence: [
            `semantic flow scan established bounded absence for ${concern}: the sensitive origin and direct binding were enumerated, every later use in changed local statements was enumerated, and every use was classified known-local`,
            ...localUse.evidence,
            ...semantic.evidence,
          ],
          ...binding,
        });
        continue;
      }
      evidence.push({
        concern,
        producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
        outcome: "NOT_CHECKED",
        claim: "NEGATIVE_ABSENCE",
        completeness: "INCOMPLETE",
        coverage: semantic.coverage === "UNSUPPORTED" ? "UNSUPPORTED" : "PARTIAL",
        strength: "STRUCTURAL",
        analysisScope: localUse.analysisScope,
        evidence: [
          `semantic flow scan did not establish bounded absence for ${concern}; detector silence is not negative evidence when origin/binding/use enumeration or language coverage is incomplete`,
          ...localUse.evidence,
          ...semantic.evidence,
        ],
        ...binding,
      });
    }
  }

  return evidence;
};
