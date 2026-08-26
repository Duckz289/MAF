import type {
  AnalysisCoverage,
  AssuranceCheck,
  AssurancePlan,
  QualityPreference,
  RequirementOrigin,
} from "./assurance";
import {
  type AdequacyCapabilityId,
  type AssuranceQuestionType,
  type ConcernType,
  type EvidenceClaim,
  type EvidenceCompleteness,
  type EvidenceStrength,
  type LanguageClass,
  capabilitiesEstablishing,
  capabilityCoverageFor,
  capabilitySupportsEvidenceClaim,
  meetsStrength,
} from "./capability-adequacy";
import type { ConcernDiscoveryResult, DiscoveredConcern } from "./concern-discovery";
import type { QualityCheckResult, QualityDimension, QualityReport } from "./quality";

/**
 * The trust kernel's obligation layer.
 *
 * Before this module existed, promotion folded directly over the QualityReport's dimensions and
 * consulted the AssurancePlan only to decide whether a dimension gated. Three things fell through
 * that fold, each independently reproduced from the live code:
 *
 * 1. A check the plan REQUIRED but for which no capability exists at all (INTEGRATION,
 *    CONCURRENCY, or any check added in future) produced no report dimension, so nothing gated
 *    and the candidate reached MERGE_ELIGIBLE with the requirement silently dropped.
 * 2. A deterministic FAIL on a dimension the planner did not predict (an ARCHITECTURE layering
 *    violation under a plan that did not require ARCHITECTURE) was reported and then ignored,
 *    because gating was plan-bound with a hand-maintained Security exception.
 * 3. A capability's PASS discharged an obligation that capability does not address — a
 *    credential-literal scan settling a sensitive-input concern, a code-content relevance scan
 *    settling a deployment-artefact concern.
 *
 * The correction is to make the thing being folded over an OBLIGATION rather than a dimension.
 * An obligation names what must be established, why, which capability can establish it, what that
 * capability actually managed to look at, and how it resolved. Trust is then a deterministic fold
 * over material obligations, with no exception list: a check with no capability, a dimension with
 * no result, and a future check nobody has wired yet all fail the same closed way, because they
 * all fail the same predicate.
 *
 * This layer is ADDITIVE. RiskVector still predicts, AssurancePlan still decides what is required,
 * QualityReport is still the per-dimension vector the UI and the delivery handoff read. The
 * obligations are derived from exactly those existing records — no new evidence is invented here,
 * and nothing that previously blocked stops blocking.
 */

/**
 * How an obligation resolved.
 *
 * PASS          the capability that addresses this obligation ran, could read the material, and
 *               established the fact.
 * FAIL          deterministic evidence that the fact does NOT hold. Never overridable.
 * WARN          checked and flagged: real evidence exists but it does not prove a problem.
 * UNKNOWN       evidence exists that the concern may apply and nothing resolved it.
 * NOT_CHECKED   the obligation was raised and no capability produced evidence for it.
 * UNSUPPORTED   a capability ran but structurally could not read the material the obligation is
 *               about. Distinct from NOT_CHECKED so "we did not look" and "we cannot look" stay
 *               separate facts.
 * NOT_REQUIRED  no source raised this obligation for this candidate. This is the ONLY status that
 *               resolves an obligation without evidence, and it is only ever assigned to
 *               obligations nothing raised — never to one that was raised and then waived.
 */
export type ObligationStatus =
  | "PASS"
  | "FAIL"
  | "WARN"
  | "UNKNOWN"
  | "NOT_CHECKED"
  | "UNSUPPORTED"
  | "NOT_REQUIRED";

/**
 * A capability is a concrete checker that exists in this build and the specific fact it can
 * legitimately establish. Capabilities are never aspirational: a check with no capability is
 * represented by the absence of an entry, not by a capability that claims it.
 */
export type CapabilityId =
  | "CORRECTNESS.TRUSTED_COMMAND"
  | "ARCHITECTURE.LAYER_BOUNDARY"
  | "DEBT.DECLARED_MARKER_DELTA"
  | "SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN"
  | "PERFORMANCE.MEASURED_METRIC"
  | "RESILIENCE.FAULT_SCENARIO_EXECUTION"
  | "REVIEW.FRESH_CONTEXT_SESSION"
  | AdequacyCapabilityId;

export interface VerifierCapability {
  id: CapabilityId;
  /** The QualityReport dimension this capability produces. */
  dimension: QualityDimension;
  /** Exactly what a PASS from this capability establishes. Scope, not aspiration. */
  establishes: string;
  /** What a PASS from this capability explicitly does NOT establish. */
  doesNotEstablish: string;
}

/**
 * The capability registry: for each assurance check, the capability that can settle it — or
 * `null`, stated explicitly, when this build has none.
 *
 * `INTEGRATION` and `CONCURRENCY` are `null` on purpose. A project's trusted verification command
 * may well exercise cross-module behaviour, but MAF cannot establish whether a given command is a
 * unit-only run or a full suite, so claiming CORRECTNESS covers INTEGRATION would be exactly the
 * over-claim this layer exists to remove. `INDEPENDENT_REVIEW` is resolved by review evidence
 * rather than a quality dimension and is handled separately in the fold.
 */
const capabilityByCheck: Record<AssuranceCheck, VerifierCapability | null> = {
  CORRECTNESS: {
    id: "CORRECTNESS.TRUSTED_COMMAND",
    dimension: "Correctness",
    establishes: "the project's own trusted verification command exited successfully",
    doesNotEstablish:
      "anything about coverage, cross-module behaviour, or what the command chose to run",
  },
  ARCHITECTURE: {
    id: "ARCHITECTURE.LAYER_BOUNDARY",
    dimension: "Architecture",
    establishes: "no added import in a supported src/domain file resolves outside the domain layer",
    doesNotEstablish: "design quality, module cohesion, or any rule outside the layering rule",
  },
  DEBT: {
    id: "DEBT.DECLARED_MARKER_DELTA",
    dimension: "DebtDelta",
    establishes: "the diff's net declared-debt marker delta",
    doesNotEstablish: "undeclared debt, complexity growth, or design erosion",
  },
  SECURITY: {
    id: "SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN",
    dimension: "Security",
    establishes:
      "no credential-shaped literal was added, and no modelled sensitive-input/credential-flow construct in a language the semantic scanner understands went to an exposure sink",
    doesNotEstablish:
      "cross-file data flow, behaviour in languages the semantic scanner does not model, or the absence of vulnerabilities generally",
  },
  PERFORMANCE: {
    id: "PERFORMANCE.MEASURED_METRIC",
    dimension: "Performance",
    establishes:
      "the declared metric, measured for this candidate id and diff digest, stayed within the declared regression bound",
    doesNotEstablish: "any metric that was not declared, or behaviour under production load",
  },
  RESILIENCE: {
    id: "RESILIENCE.FAULT_SCENARIO_EXECUTION",
    dimension: "Resilience",
    establishes:
      "every failure scenario the candidate's own CODE made relevant executed and passed in the bounded local environment",
    doesNotEstablish:
      "production resilience, or the failure behaviour of deployment/operational artefacts the relevance scan cannot read",
  },
  CONCURRENCY: null,
  INTEGRATION: null,
  INDEPENDENT_REVIEW: {
    id: "REVIEW.FRESH_CONTEXT_SESSION",
    dimension: "Correctness", // not dimension-produced; see the fold's review handling
    establishes:
      "a reviewer session that never saw the author's context approved this exact candidate id and diff digest",
    doesNotEstablish:
      "independence of authority — the reviewer may be the same adapter, model and provider as the author",
  },
};

export const capabilityForCheck = (check: AssuranceCheck): VerifierCapability | null =>
  capabilityByCheck[check] ?? null;

/** Why an obligation exists. Every obligation carries its provenance; none is anonymous. */
export type ObligationOrigin =
  | {
      kind: "PLAN_REQUIRED";
      /**
       * What made the plan require it. CANDIDATE_EVIDENCE is a concern about this candidate and
       * is always material. QUALITY_PREFERENCE is a request for depth: it deepens capabilities
       * that exist, but where none exists it is disclosed rather than turned into a demand no
       * candidate could ever satisfy. Absent on plans built before the field existed, which are
       * read as CANDIDATE_EVIDENCE — the fail-safe direction.
       */
      raisedBy: RequirementOrigin;
      /** The plan's own recorded reason for requiring this check. */
      reason: string;
    }
  | {
      kind: "DETERMINISTIC_EVIDENCE";
      /** The dimension whose deterministic result raised this obligation on its own. */
      dimension: QualityDimension;
      reason: string;
    }
  | {
      kind: "DISCOVERY_ADEQUACY";
      /** The promotion-relevant epistemic state observed directly from this candidate's diff. */
      conclusion: "CONCERNS_FOUND" | "ABSENCE_ESTABLISHED" | "INCOMPLETE";
      reason: string;
    };

export interface AssuranceObligation {
  /** Stable identity: the assurance family plus the fact being established. */
  id: string;
  check: AssuranceCheck | "DISCOVERY_ADEQUACY" | "UNKNOWN_CHECK";
  origin: ObligationOrigin;
  /** Whether an unresolved status blocks promotion. */
  material: boolean;
  /** The candidate this obligation and its evidence are bound to. */
  candidateId: string | null;
  diffDigest: string | null;
  /** The capability that can settle it, or null when this build has none. */
  requiredCapability: CapabilityId | null;
  /** The capability that actually produced the evidence, or null when nothing did. */
  producedBy: CapabilityId | null;
  status: ObligationStatus;
  /** How much of the relevant material the producing capability could read. */
  coverage: AnalysisCoverage;
  evidence: string[];
  /** Why this status, in one line — always present, including for NOT_REQUIRED. */
  justification: string;
}

/** Statuses that leave an obligation open. NOT_REQUIRED is resolved; nothing else without PASS is. */
const isResolved = (status: ObligationStatus): boolean =>
  status === "PASS" || status === "NOT_REQUIRED";

const dimensionCheck = new Map<QualityDimension, AssuranceCheck>(
  (Object.entries(capabilityByCheck) as Array<[AssuranceCheck, VerifierCapability | null]>)
    .filter(
      (entry): entry is [AssuranceCheck, VerifierCapability] =>
        entry[1] !== null && entry[0] !== "INDEPENDENT_REVIEW",
    )
    .map(([check, capability]) => [capability.dimension, check]),
);

const statusFromQuality = (result: QualityCheckResult): ObligationStatus => {
  switch (result.state) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return "FAIL";
    case "WARN":
      return "WARN";
    case "UNKNOWN":
      return "UNKNOWN";
    case "NOT_REQUIRED":
      return "NOT_REQUIRED";
    default:
      // NOT_CHECKED from a capability that ran but could not read the material is UNSUPPORTED;
      // NOT_CHECKED with nothing to read is simply not checked. The distinction is carried by the
      // result's own coverage field, never guessed from the verdict.
      return result.coverage === "UNSUPPORTED" || result.coverage === "PARTIAL"
        ? "UNSUPPORTED"
        : "NOT_CHECKED";
  }
};

/**
 * Typed, per-capability evidence for one concern about one candidate.
 *
 * This exists because of a composition failure found by adversarial probing after the typed
 * concern layer landed. Concern obligations were resolved by consulting the BROAD `report.Security`
 * dimension: if that bucket said PASS, a typed concern with adequate coverage and strength
 * resolved. But the Security bucket is a summary of DIFFERENT questions — the credential-literal
 * posture scan and the semantic flow scan folded into one state. So a bucket PASS produced by the
 * credential scanner could still discharge a typed sensitive-input-flow concern, which is finding
 * H1 reappearing one level up: capability B resolving obligation A, now via a summary rather than
 * via a registry entry.
 *
 * The invariant this restores: **a typed concern is resolved only by evidence produced FOR that
 * concern by a capability that establishes it.** A broad dimension state is a projection for the
 * UI and must never be an input to typed resolution. Absent typed evidence, a raised concern stays
 * unresolved — the fail-safe direction, and the one that keeps "nobody produced evidence" from
 * reading as "somebody proved it".
 */
export interface ConcernEvidence {
  concern: ConcernType;
  /** The capability that produced this evidence. Must establish the concern to count. */
  producedBy: AdequacyCapabilityId;
  /** What that capability found: PASS is legal only for complete negative evidence. */
  outcome: "PASS" | "WARN" | "FAIL" | "NOT_CHECKED";
  claim: EvidenceClaim;
  completeness: EvidenceCompleteness;
  coverage: AnalysisCoverage;
  strength: EvidenceStrength;
  analysisScope: string;
  evidence: string[];
  /** The candidate this evidence was produced for; stale evidence must not resolve a new candidate. */
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
}

/**
 * Capability-stamped evidence for a plan-level assurance question. A question identifies which
 * concern family needs triage; it is not itself an exact concern and cannot resolve any typed
 * concern produced by that triage.
 */
export interface AssuranceQuestionEvidence {
  question: AssuranceQuestionType;
  check: "SECURITY" | "RESILIENCE" | "DISCOVERY_ADEQUACY";
  producedBy: AdequacyCapabilityId;
  outcome: "PASS" | "WARN" | "FAIL" | "NOT_CHECKED";
  claim: EvidenceClaim;
  completeness: EvidenceCompleteness;
  coverage: AnalysisCoverage;
  strength: EvidenceStrength;
  languageClasses: LanguageClass[];
  analysisScope: string;
  /**
   * Structured changed-scope coverage for DISCOVERY_ADEQUACY. Candidate/digest binding alone does
   * not prove that a later COMPLETE record consumed the residual units observed earlier.
   */
  discoveryScope?:
    | {
        unit: "CHANGED_LOCAL_STATEMENT";
        totalRelevantUnits: number;
        coveredUnits: number;
        residualUnits: number;
        /**
         * The exact unit identities this record claims to cover (P1.3). Counts alone let a producer
         * claim "10/10 covered" while having analyzed a different set of 10 units, so promotion
         * -authoritative stronger evidence must name the scope it analyzed. Optional for records
         * produced before the field existed; the fold requires it for a clean negative PASS.
         */
        unitIdentities?: string[] | undefined;
      }
    | undefined;
  evidence: string[];
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
}

export interface ObligationDerivationInput {
  plan: AssurancePlan;
  report: QualityReport;
  candidateId?: string | undefined;
  diffDigest?: string | undefined;
  /**
   * Concerns discovered structurally from the diff, independent of path naming. Optional: absent
   * means the caller did not run discovery, which changes nothing about the existing obligations.
   */
  concerns?: DiscoveredConcern[] | undefined;
  /** The complete discovery result; when present, scope adequacy is independently material. */
  discovery?: ConcernDiscoveryResult | undefined;
  /** Language classes the diff actually touched, for capability-specific coverage. */
  touchedClasses?: LanguageClass[] | undefined;
  /** The requested assurance depth, which sets the minimum evidence strength (Part E). */
  qualityPreference?: QualityPreference | undefined;
  /** Typed per-concern evidence. The ONLY thing that can resolve a discovered concern. */
  concernEvidence?: ConcernEvidence[] | undefined;
  /** Capability-stamped evidence for plan Security/Resilience questions. */
  assuranceQuestionEvidence?: AssuranceQuestionEvidence[] | undefined;
}

/**
 * The minimum evidence strength a requested depth demands (Part E, finding H2).
 *
 * CRITICAL previously meant "also run the cheap capabilities that happen to exist", which is why a
 * trivial formatter under CRITICAL collected a regex-grade Security PASS and merged. Depth is a
 * statement about CONFIDENCE, so it is expressed as the weakest evidence that may settle a
 * concern. Note this only ever applies to concerns that were actually RAISED: a CRITICAL request
 * on a candidate where no security shape exists raises no security concern, so it demands no
 * security lab. Policy increases confidence; it does not manufacture obligations.
 */
const requiredStrengthFor = (preference: QualityPreference | undefined): EvidenceStrength =>
  preference === "CRITICAL" ? "BEHAVIORAL" : preference === "HIGH" ? "STRUCTURAL" : "LEXICAL";

/**
 * The evidence strength a QualityReport dimension result actually carries.
 *
 * Provenance is the honest signal and is already recorded per result: MEASURED was executed and
 * observed against this candidate; DETERMINISTIC is a static rule or scan over the diff — real
 * evidence, structural at best; PENDING_CHECKER is not evidence.
 */
const strengthOfResult = (result: QualityCheckResult): EvidenceStrength =>
  result.provenance === "MEASURED"
    ? "MEASURED"
    : result.provenance === "DETERMINISTIC"
      ? "STRUCTURAL"
      : "LEXICAL";

/**
 * Checks whose bucket obligation a depth request can legitimately raise the bar for.
 *
 * This narrowness is the correction to a real over-block this pass produced and then caught: an
 * earlier form applied the depth requirement to EVERY plan-required check, so CRITICAL left
 * CORRECTNESS unresolved even when the project's own trusted test command had passed. That is
 * incoherent — for CORRECTNESS, executing the suite IS the strongest evidence MAF can obtain, and
 * a depth preference that no candidate can ever satisfy is exactly the permanently-unmeetable
 * demand Part E forbids.
 *
 * Depth therefore applies only where a STRONGER capability is a coherent thing to ask for: an
 * analytic scan whose verdict could in principle be upgraded by behavioural or measured evidence.
 * SECURITY is the live case — a credential/flow regex is not what "critical assurance" means.
 * CORRECTNESS, DEBT and ARCHITECTURE are excluded because their checkers are already the complete
 * and appropriate answer to the question they ask, not a cheap proxy for a deeper one.
 */
const depthSensitiveChecks = new Set<AssuranceCheck>(["SECURITY", "RESILIENCE"]);

/**
 * Whether a depth shortfall on a bucket obligation should actually withhold resolution.
 *
 * The second correction, from the same over-block. A depth request raises the bar for a concern
 * that EXISTS; it must not convert "these file paths look sensitive" into a permanent block when
 * the diff contains no material shape and the only capability in the build is the analytic one.
 *
 * So the shortfall withholds resolution only when structural discovery actually found a material
 * concern for that check. That keeps the two halves of Part E in balance:
 *
 *   - a CRITICAL task whose diff really does handle secrets, subprocesses or authorization gets a
 *     genuinely higher bar, and the capability gap is reported rather than downgraded;
 *   - a CRITICAL task that merely touches `src/auth/` while changing a constant is not held to a
 *     standard no candidate could ever meet.
 *
 * Path keywords raise the PLAN's requirement; only discovered shapes make the depth demand bite.
 */
const depthShortfallBites = (
  check: AssuranceCheck,
  concerns: DiscoveredConcern[] | undefined,
): boolean => {
  if (!concerns || concerns.length === 0) return false;
  const family = check === "SECURITY" ? "SECURITY" : "RESILIENCE";
  return concerns.some((concern) => concern.concern.startsWith(family));
};

const adequacyCoverageRank: Record<AnalysisCoverage, number> = {
  UNSUPPORTED: 0,
  PARTIAL: 1,
  FULL: 2,
  NOT_APPLICABLE: 3,
};

const adequacyStrengthRank: Record<EvidenceStrength, number> = {
  LEXICAL: 0,
  STRUCTURAL: 1,
  BEHAVIORAL: 2,
  MEASURED: 3,
};

const concernOutcomeRiskRank: Record<ConcernEvidence["outcome"], number> = {
  PASS: 0,
  NOT_CHECKED: 1,
  WARN: 2,
  FAIL: 3,
};

const weakerCoverage = (left: AnalysisCoverage, right: AnalysisCoverage): AnalysisCoverage =>
  adequacyCoverageRank[left] <= adequacyCoverageRank[right] ? left : right;

const evidenceBindingMatches = (
  evidence: { candidateId?: string | undefined; diffDigest?: string | undefined },
  candidateId: string | null,
  diffDigest: string | null,
): boolean => {
  const candidateOk =
    evidence.candidateId === undefined
      ? candidateId === null
      : evidence.candidateId === candidateId;
  const digestOk =
    evidence.diffDigest === undefined ? diffDigest === null : evidence.diffDigest === diffDigest;
  return candidateOk && digestOk;
};

/**
 * Explicit producer policy: candidate-bound establishing evidence only; adequate coverage and
 * required strength for clean resolution; stronger evidence first; deterministic capability-id
 * tie-breaking. Registry order is never a trust decision.
 */
const deriveQuestionObligation = (
  check: "SECURITY" | "RESILIENCE" | "DISCOVERY_ADEQUACY",
  raisedBy: RequirementOrigin,
  reason: string,
  input: ObligationDerivationInput,
  candidateId: string | null,
  diffDigest: string | null,
): AssuranceObligation => {
  const records = (input.assuranceQuestionEvidence ?? []).filter((item) => item.check === check);
  const current = records.filter((item) => evidenceBindingMatches(item, candidateId, diffDigest));
  const evaluated = current
    .map((record) => {
      const producers = capabilitiesEstablishing(record.question);
      if (!producers.includes(record.producedBy)) return null;
      const claimSupported = capabilitySupportsEvidenceClaim(
        record.producedBy,
        record.question,
        record.claim,
      );
      const registry = capabilityCoverageFor(
        record.producedBy,
        record.question,
        record.languageClasses,
        claimSupported ? record.claim : "POSITIVE_FINDING",
      );
      const coverage =
        record.claim === "POSITIVE_FINDING"
          ? record.coverage
          : weakerCoverage(record.coverage, registry.coverage);
      const maximumStrength = registry.strength ?? "LEXICAL";
      const strength =
        adequacyStrengthRank[record.strength] <= adequacyStrengthRank[maximumStrength]
          ? record.strength
          : maximumStrength;
      const requiredStrength: EvidenceStrength = record.question.endsWith("SCENARIO_EXECUTION")
        ? "MEASURED"
        : "STRUCTURAL";
      const completenessAdequate =
        record.claim === "POSITIVE_FINDING"
          ? record.completeness === "NOT_APPLICABLE"
          : record.completeness === "COMPLETE";
      const coverageAdequate =
        record.claim === "POSITIVE_FINDING" || coverage === "FULL" || coverage === "NOT_APPLICABLE";
      const claimedIdentities = record.discoveryScope?.unitIdentities;
      const actualIdentities = input.discovery?.scopeAccounting.unitIdentities;
      // P1.3: identity, not arithmetic. A claim covering the right NUMBER of units but naming a
      // different SET of units is not evidence about this candidate's scope.
      const identityBound =
        claimedIdentities !== undefined &&
        actualIdentities !== undefined &&
        claimedIdentities.length === actualIdentities.length &&
        claimedIdentities.every((identity, index) => identity === actualIdentities[index]);
      const discoveryScopeAdequate =
        check !== "DISCOVERY_ADEQUACY" ||
        record.claim === "POSITIVE_FINDING" ||
        record.outcome !== "PASS" ||
        (record.discoveryScope?.unit === "CHANGED_LOCAL_STATEMENT" &&
          record.discoveryScope.totalRelevantUnits ===
            input.discovery?.scopeAccounting.totalRelevantUnits &&
          record.discoveryScope.coveredUnits === record.discoveryScope.totalRelevantUnits &&
          record.discoveryScope.residualUnits === 0 &&
          identityBound);
      const adequate =
        claimSupported &&
        completenessAdequate &&
        coverageAdequate &&
        discoveryScopeAdequate &&
        meetsStrength(strength, requiredStrength);
      return {
        record,
        coverage,
        strength,
        requiredStrength,
        claimSupported,
        completenessAdequate,
        discoveryScopeAdequate,
        adequate,
      };
    })
    .filter((item) => item !== null)
    .toSorted(
      (left, right) =>
        Number(right.adequate) - Number(left.adequate) ||
        adequacyStrengthRank[right.strength] - adequacyStrengthRank[left.strength] ||
        adequacyCoverageRank[right.coverage] - adequacyCoverageRank[left.coverage] ||
        left.record.producedBy.localeCompare(right.record.producedBy),
    );
  const negative = evaluated.find(
    (item) =>
      item.claimSupported && (item.record.outcome === "FAIL" || item.record.outcome === "WARN"),
  );
  const completeAbsence = evaluated.find(
    (item) =>
      item.record.outcome === "PASS" && item.record.claim === "NEGATIVE_ABSENCE" && item.adequate,
  );
  const positiveWitness = evaluated.find(
    (item) =>
      item.record.outcome === "PASS" && item.record.claim === "POSITIVE_FINDING" && item.adequate,
  );
  const rejectedUnscopedAbsence = evaluated.find(
    (item) =>
      item.record.outcome === "PASS" &&
      item.record.claim === "NEGATIVE_ABSENCE" &&
      !item.discoveryScopeAdequate,
  );
  const discoveryRemainderIncomplete =
    check === "DISCOVERY_ADEQUACY" && input.discovery?.scopeAccounting.complete === false;
  // Producer ordering is not the adequacy policy. A complete same-candidate absence record may
  // resolve an earlier gap, but a positive witness cannot erase the current discovery result's
  // unsupported/unclassified remainder. It is eligible only when independent scope accounting is
  // complete for the full relevant changed scope.
  const selected =
    negative ?? completeAbsence ?? (!discoveryRemainderIncomplete ? positiveWitness : undefined);
  const incompleteRemainder =
    evaluated.find(
      (item) => item.record.claim === "NEGATIVE_ABSENCE" && item.record.outcome === "NOT_CHECKED",
    ) ?? evaluated.find((item) => item.record.claim === "NEGATIVE_ABSENCE" && !item.adequate);
  const best =
    selected ?? (discoveryRemainderIncomplete ? incompleteRemainder : undefined) ?? evaluated[0];
  const status: ObligationStatus = negative
    ? negative.record.outcome
    : selected?.record.outcome === "PASS"
      ? "PASS"
      : best?.coverage === "UNSUPPORTED"
        ? "UNSUPPORTED"
        : best
          ? best.record.outcome === "NOT_CHECKED"
            ? "NOT_CHECKED"
            : "UNKNOWN"
          : "NOT_CHECKED";
  // A quality preference asks for depth but does not itself observe a candidate concern. If the
  // only result is incomplete negative search, record the gap without manufacturing a material
  // blocker. Candidate-evidence plans remain fail-closed, and any positive finding is material
  // through the typed concern it raises.
  const discoveryAdequacy = check === "DISCOVERY_ADEQUACY";
  const material =
    discoveryAdequacy ||
    raisedBy === "CANDIDATE_EVIDENCE" ||
    (raisedBy === "QUALITY_PREFERENCE" && capabilityForCheck(check) !== null) ||
    negative !== undefined ||
    evaluated.some((item) => item.record.claim === "POSITIVE_FINDING");

  return {
    id: discoveryAdequacy ? "DISCOVERY.ADEQUACY" : `${check}.ASSURANCE_QUESTION`,
    check,
    origin: discoveryAdequacy
      ? {
          kind: "DISCOVERY_ADEQUACY",
          conclusion: input.discovery?.scopeAdequacy.conclusion ?? "INCOMPLETE",
          reason,
        }
      : { kind: "PLAN_REQUIRED", raisedBy, reason },
    material,
    candidateId,
    diffDigest,
    requiredCapability: best?.record.producedBy ?? null,
    producedBy: selected?.record.producedBy ?? best?.record.producedBy ?? null,
    status,
    coverage: best?.coverage ?? "NOT_APPLICABLE",
    evidence: [
      reason,
      ...(best?.record.evidence ?? []),
      ...(records.length > current.length
        ? [
            `${records.length - current.length} plan-assurance evidence record(s) were rejected because they were not bound to this candidate id/diff digest`,
          ]
        : []),
      ...(best && !best.adequate
        ? [
            `${best.record.producedBy} produced ${best.record.claim} / ${best.record.completeness} evidence at ${best.coverage} coverage with ${best.strength} strength; ${best.requiredStrength} evidence is required for ${best.record.question}, and a negative PASS additionally requires an explicitly COMPLETE FULL/NOT_APPLICABLE scope`,
          ]
        : []),
      ...(best && !best.claimSupported
        ? [
            `${best.record.producedBy} is not permitted to make a ${best.record.claim} claim for ${best.record.question}; positive detection authority is not negative-absence authority`,
          ]
        : []),
      ...(rejectedUnscopedAbsence
        ? [
            `${rejectedUnscopedAbsence.record.producedBy} did not provide structured changed-unit coverage matching this candidate's ${input.discovery?.scopeAccounting.totalRelevantUnits ?? 0} relevant unit(s) with zero residual; COMPLETE plus candidate/digest binding is not magical authority over previously unaccounted scope`,
          ]
        : []),
      ...(discoveryRemainderIncomplete && positiveWitness !== undefined && !completeAbsence
        ? [
            `${positiveWitness.record.producedBy} proved that at least one concrete concern was found, but the candidate still contains unsupported or unclassified changed-scope remainder; a positive witness is not exhaustive discovery evidence`,
          ]
        : []),
      ...(!best
        ? [
            discoveryAdequacy
              ? "no candidate-bound capability evidence addressed discovery scope adequacy; known incompleteness cannot be inferred away"
              : `no candidate-bound capability evidence addressed the plan-level ${check} assurance question; the broad QualityReport.${check === "SECURITY" ? "Security" : "Resilience"} bucket is a UI/report projection and is deliberately not consulted`,
          ]
        : []),
      ...(!discoveryAdequacy && !material
        ? [
            `${check} was requested only by QUALITY_PREFERENCE and no positive candidate concern was found; incomplete negative search is disclosed but does not manufacture a material concern`,
          ]
        : []),
    ],
    justification:
      status === "PASS" && selected
        ? selected.record.claim === "POSITIVE_FINDING"
          ? `${selected.record.producedBy} raised concrete evidence for ${selected.record.question}; typed concerns own the resulting safety questions`
          : `${selected.record.producedBy} established bounded absence for ${selected.record.question} with COMPLETE ${selected.strength} evidence at ${selected.coverage} coverage`
        : discoveryAdequacy
          ? "material-concern discovery explicitly remains incomplete for this candidate; stronger candidate-bound scope evidence is required"
          : `the plan required ${check}, but no candidate-bound capability established its assurance question to the required coverage and strength`,
  };
};

/**
 * Raises an obligation per DISCOVERED concern and resolves it only if a capability that actually
 * establishes that concern ran, with adequate coverage and adequate evidence strength.
 *
 * This is where C3 closes. A concern discovered from a structural shape in an unmodelled language
 * exists whether or not any path keyword matched, so `SECURITY = NOT_REQUIRED` is no longer
 * reachable by naming a file `cmd/server.go`. And because the concern is matched to a capability
 * rather than to a bucket, an unmodelled language produces UNSUPPORTED coverage and the obligation
 * stays open — "the analyzer found nothing" is never the reason it closes.
 */
const deriveConcernObligations = (
  input: ObligationDerivationInput,
  candidateId: string | null,
  diffDigest: string | null,
): AssuranceObligation[] => {
  const concerns = input.concerns ?? [];
  if (concerns.length === 0) return [];
  const requiredStrength = requiredStrengthFor(input.qualityPreference);
  const obligations: AssuranceObligation[] = [];
  const byType = new Map<ConcernType, DiscoveredConcern[]>();
  for (const concern of concerns) {
    byType.set(concern.concern, [...(byType.get(concern.concern) ?? []), concern]);
  }

  for (const [concernType, raised] of byType) {
    const classes = [...new Set(raised.map((item) => item.languageClass))];
    const producers = capabilitiesEstablishing(concernType);
    const shapes = raised.slice(0, 5).map((item) => `${item.file}: ${item.evidence}`);
    const check: AssuranceCheck = concernType.startsWith("SECURITY") ? "SECURITY" : "RESILIENCE";

    const fallbackProducer = producers[0];
    if (fallbackProducer === undefined) {
      // No capability in this build establishes this concern at all — authorization correctness is
      // the live example. The obligation is recorded as unresolved rather than dropped, and no
      // capability's PASS anywhere can close it, because nothing claims to establish it.
      obligations.push({
        id: `${concernType}.NO_CAPABILITY`,
        check,
        origin: {
          kind: "DETERMINISTIC_EVIDENCE",
          dimension: check === "SECURITY" ? "Security" : "Resilience",
          reason: `structural shapes in the candidate's added code raise ${concernType}`,
        },
        material: true,
        candidateId,
        diffDigest,
        requiredCapability: null,
        producedBy: null,
        status: "NOT_CHECKED",
        coverage: "NOT_APPLICABLE",
        evidence: [
          ...shapes,
          `no capability in this build establishes ${concernType}; the concern is recorded as unresolved rather than discharged by a checker that answers a different question`,
        ],
        justification: `${concernType} was raised by evidence in this candidate and no capability can establish it`,
      });
      continue;
    }

    // Typed evidence only. The producing capability must (a) exist for this concern, (b) have
    // actually produced evidence FOR this concern, and (c) have produced it for THIS candidate.
    // A broad Security/Resilience dimension state is deliberately not consulted here.
    const matching = (input.concernEvidence ?? []).filter(
      (item) => item.concern === concernType && producers.includes(item.producedBy),
    );
    // Provenance: evidence stamped for a different candidate or digest is stale and cannot resolve
    // this candidate's obligation. Unstamped evidence is accepted only when the derivation itself
    // is unbound, so a bound derivation can never be settled by an unbound record.
    const boundToCandidate = matching.filter((item) =>
      evidenceBindingMatches(item, candidateId, diffDigest),
    );
    const stale = matching.length - boundToCandidate.length;
    const evaluated = boundToCandidate
      .map((record) => {
        const claimSupported = capabilitySupportsEvidenceClaim(
          record.producedBy,
          concernType,
          record.claim,
        );
        const registry = capabilityCoverageFor(
          record.producedBy,
          concernType,
          classes,
          claimSupported ? record.claim : "POSITIVE_FINDING",
        );
        const coverage =
          record.claim === "POSITIVE_FINDING"
            ? record.coverage
            : weakerCoverage(record.coverage, registry.coverage);
        const verdict = { ...registry, coverage };
        const maximumStrength = registry.strength ?? "LEXICAL";
        const strength =
          adequacyStrengthRank[record.strength] <= adequacyStrengthRank[maximumStrength]
            ? record.strength
            : maximumStrength;
        const completenessAdequate =
          record.claim === "POSITIVE_FINDING"
            ? record.completeness === "NOT_APPLICABLE"
            : record.completeness === "COMPLETE";
        const adequateCoverage =
          record.claim === "POSITIVE_FINDING" ||
          coverage === "FULL" ||
          coverage === "NOT_APPLICABLE";
        const adequate =
          claimSupported &&
          completenessAdequate &&
          adequateCoverage &&
          meetsStrength(strength, requiredStrength);
        return {
          record,
          verdict,
          strength,
          claimSupported,
          completenessAdequate,
          adequate,
        };
      })
      .toSorted(
        (left, right) =>
          Number(right.adequate) - Number(left.adequate) ||
          concernOutcomeRiskRank[right.record.outcome] -
            concernOutcomeRiskRank[left.record.outcome] ||
          adequacyStrengthRank[right.strength] - adequacyStrengthRank[left.strength] ||
          adequacyCoverageRank[right.verdict.coverage] -
            adequacyCoverageRank[left.verdict.coverage] ||
          left.record.producedBy.localeCompare(right.record.producedBy),
      );
    const negative = evaluated.find(
      (item) =>
        item.claimSupported && (item.record.outcome === "FAIL" || item.record.outcome === "WARN"),
    );
    const clean = evaluated.find((item) => item.record.outcome === "PASS" && item.adequate);
    const selected = negative ?? clean ?? evaluated[0];
    const verdict =
      selected?.verdict ??
      capabilityCoverageFor(fallbackProducer, concernType, classes, "NEGATIVE_ABSENCE");
    const strength = selected?.strength ?? verdict.strength;
    const strongEnough = strength !== null && meetsStrength(strength, requiredStrength);
    const adequateCoverage = verdict.coverage === "FULL" || verdict.coverage === "NOT_APPLICABLE";
    const resolved = negative === undefined && clean !== undefined;
    const status: ObligationStatus =
      negative !== undefined
        ? negative.record.outcome === "FAIL"
          ? "FAIL"
          : "WARN"
        : resolved
          ? "PASS"
          : verdict.coverage === "UNSUPPORTED"
            ? "UNSUPPORTED"
            : boundToCandidate.length === 0
              ? "NOT_CHECKED"
              : selected?.record.outcome === "NOT_CHECKED"
                ? "NOT_CHECKED"
                : "UNKNOWN";

    obligations.push({
      id: `${concernType}.ADEQUACY`,
      check,
      origin: {
        kind: "DETERMINISTIC_EVIDENCE",
        dimension: check === "SECURITY" ? "Security" : "Resilience",
        reason: `structural shapes in the candidate's added code raise ${concernType}`,
      },
      material: true,
      candidateId,
      diffDigest,
      requiredCapability: selected?.record.producedBy ?? producers[0] ?? null,
      producedBy: selected?.record.producedBy ?? null,
      status,
      coverage: verdict.coverage,
      evidence: [
        ...shapes,
        verdict.reason,
        ...boundToCandidate.flatMap((item) => item.evidence),
        ...(boundToCandidate.length === 0
          ? [
              `no capability produced evidence for ${concernType} on this candidate; the broad ${check} dimension state is a projection of other questions and is deliberately not read as evidence for this one`,
            ]
          : []),
        ...(stale > 0
          ? [
              `${stale} evidence record(s) for ${concernType} were produced for a different candidate id/diff digest and were rejected as stale`,
            ]
          : []),
        ...(strength !== null && !strongEnough
          ? [
              `the requested assurance depth (${input.qualityPreference ?? "BALANCED"}) requires at least ${requiredStrength} evidence for this concern; ${selected?.record.producedBy ?? producers.join(" or ")} produces ${strength} evidence, which cannot satisfy it. No adequate candidate-bound producer was selected — the gap is reported rather than silently downgraded.`,
            ]
          : []),
        ...(selected && !selected.claimSupported
          ? [
              `${selected.record.producedBy} is not permitted to make a ${selected.record.claim} claim for ${concernType}`,
            ]
          : []),
        ...(selected && !selected.completenessAdequate
          ? [
              `${selected.record.producedBy} reported ${selected.record.completeness} completeness for ${selected.record.analysisScope}; negative PASS requires COMPLETE enumeration and classification of that exact scope`,
            ]
          : []),
        ...(!adequateCoverage
          ? [
              `coverage for ${concernType} over ${classes.join(", ")} is ${verdict.coverage}; a no-signal result there is not an observation about this candidate`,
            ]
          : []),
      ],
      justification: resolved
        ? `${clean.record.producedBy} established bounded absence for ${concernType} at ${clean.verdict.coverage} coverage with COMPLETE ${clean.strength} evidence`
        : negative !== undefined
          ? `${negative.record.producedBy} found a signal for ${concernType}; the concern is flagged, not discharged`
          : `${concernType} was raised by evidence in this candidate and no capability established it to the required standard`,
    });
  }
  return obligations;
};

/**
 * Derives the material obligation set for a candidate from the plan it was held to and the quality
 * evidence actually produced for it.
 *
 * Three sources raise an obligation:
 *
 * - the AssurancePlan requiring a check (origin PLAN_REQUIRED). Every required check produces an
 *   obligation, whether or not a capability exists and whether or not the report has a matching
 *   dimension. A required check with no capability resolves NOT_CHECKED and blocks; a required
 *   check whose dimension is missing from the report resolves NOT_CHECKED and blocks. Neither can
 *   be silently dropped, because neither is looked up by iterating the report.
 *
 * - a deterministic checker producing FAIL on its own (origin DETERMINISTIC_EVIDENCE), whether or
 *   not the planner predicted that dimension mattered. A broken rule is evidence, and evidence
 *   does not become irrelevant because a heuristic planner did not anticipate it. This replaces
 *   the previous hand-maintained "Security also gates unconditionally" exception with a rule that
 *   covers every dimension, present and future.
 *
 * - discovery scope adequacy (origin DISCOVERY_ADEQUACY), whenever discovery ran for the current
 *   diff. It is independent of the plan: CONCERNS_FOUND produces typed work, bounded
 *   ABSENCE_ESTABLISHED resolves progressively, and INCOMPLETE stays materially unresolved until
 *   a capability supplies complete candidate-bound evidence.
 *
 * Discovery adequacy additionally raises a material obligation whenever discovery explicitly
 * reports that the changed scope remains incomplete, even when the plan did not require Security.
 * This is not a broad Security bucket: typed concerns and plan questions remain separate.
 */
export const deriveAssuranceObligations = (
  input: ObligationDerivationInput,
): AssuranceObligation[] => {
  const { plan, report } = input;
  const candidateId = input.candidateId ?? null;
  const diffDigest = input.diffDigest ?? null;
  const obligations: AssuranceObligation[] = [];
  const claimed = new Set<QualityDimension>();

  if (input.discovery !== undefined) {
    obligations.push(
      deriveQuestionObligation(
        "DISCOVERY_ADEQUACY",
        "CANDIDATE_EVIDENCE",
        `material-concern discovery concluded ${input.discovery.scopeAdequacy.conclusion} for the changed scope`,
        input,
        candidateId,
        diffDigest,
      ),
    );
  }

  for (const check of plan.required) {
    if (check === "INDEPENDENT_REVIEW") continue; // resolved by review evidence, not a dimension
    const reason = plan.reasons[check] ?? "the assurance plan required this check";
    // Fail-safe default: a plan with no recorded origin (built before the field existed, or by a
    // caller that did not set it) is read as candidate evidence, which is the material reading.
    const raisedBy: RequirementOrigin = plan.requirementOrigin?.[check] ?? "CANDIDATE_EVIDENCE";
    // Security and Resilience are concern families, not single facts. Their broad QualityReport
    // buckets remain projections for UI/reporting, but cannot independently settle the plan. The
    // plan obligation reads only capability-stamped assurance-question evidence; any typed concern
    // produced by that triage resolves separately below.
    if (check === "SECURITY" || check === "RESILIENCE") {
      obligations.push(
        deriveQuestionObligation(check, raisedBy, reason, input, candidateId, diffDigest),
      );
      continue;
    }
    const capability = capabilityForCheck(check);
    if (!capability) {
      // Trust invariant B. A required check with no capability in this build — INTEGRATION,
      // CONCURRENCY, or a check added later and not yet wired — is unresolved, not absent. This
      // branch is also what makes a NEW assurance check fail safe by default: nothing has to be
      // added to a gate list for it to block.
      const material = raisedBy === "CANDIDATE_EVIDENCE";
      obligations.push({
        id: `${check}.NO_CAPABILITY`,
        check,
        origin: { kind: "PLAN_REQUIRED", raisedBy, reason },
        material,
        candidateId,
        diffDigest,
        requiredCapability: null,
        producedBy: null,
        status: "NOT_CHECKED",
        coverage: "NOT_APPLICABLE",
        evidence: [
          reason,
          `no capability in this build can produce evidence for ${check}; the requirement is recorded as unresolved rather than dropped`,
          material
            ? `${check} was raised by evidence about this candidate, so the unresolved obligation blocks promotion`
            : `${check} was raised by the quality preference rather than by evidence about this candidate; the capability gap is disclosed and does not by itself block promotion, because a depth preference cannot manufacture a concern that no candidate could ever discharge`,
        ],
        justification: `${check} was required and no capability exists to establish it`,
      });
      continue;
    }
    const result = report[capability.dimension] as QualityCheckResult | undefined;
    claimed.add(capability.dimension);
    if (!result) {
      // Trust invariant B / Phase 1 item 3: a required check whose producing dimension is absent
      // from the report is unresolved. Iterating the plan rather than the report is what makes a
      // missing key impossible to ignore.
      obligations.push({
        id: `${check}.NO_RESULT`,
        check,
        origin: { kind: "PLAN_REQUIRED", raisedBy, reason },
        material: true,
        candidateId,
        diffDigest,
        requiredCapability: capability.id,
        producedBy: null,
        status: "NOT_CHECKED",
        coverage: "NOT_APPLICABLE",
        evidence: [
          reason,
          `the quality report carries no ${capability.dimension} result, so ${capability.id} produced nothing for this candidate`,
        ],
        justification: `${check} was required and its producing dimension is missing from the report`,
      });
      continue;
    }
    const status = statusFromQuality(result);
    const coverage = result.coverage ?? "NOT_APPLICABLE";
    // Trust invariant C, applied generically: a PASS only resolves what the producing capability
    // actually managed to read.
    //
    // Hardening pass #5 (finding C1). The previous form downgraded a PASS only under UNSUPPORTED
    // coverage, so PARTIAL — "the generic binding shapes transfer, the language's own idioms do
    // not" — resolved a material obligation outright. An independent re-audit reproduced exactly
    // that: a Ruby file reading a password off stdin and warning it produced coverage PARTIAL,
    // Security PASS, and MERGE_ELIGIBLE. The same held for PHP.
    //
    // PARTIAL is a statement that absence of a signal is WEAKER than an observation. Treating it
    // as proof is the definition of false confidence, so a material obligation under PARTIAL
    // coverage now resolves UNKNOWN: the cheap capability's finding is preserved as evidence
    // (nothing is discarded, and progressive assurance can still close the gap with a focused
    // probe), but uncertainty is not converted into safety.
    //
    // Non-material obligations are unaffected: a depth preference that ran a partial scan and
    // found nothing does not need to block, because nothing about the candidate raised it.
    const partialUnderMaterial = status === "PASS" && coverage === "PARTIAL";
    // Depth applies to bucket obligations too (finding H2, bucket half), but only where asking for
    // a stronger capability is coherent AND the check was raised by evidence about this candidate.
    // A depth preference must not manufacture a concern (Part E): if nothing about the candidate
    // raised SECURITY, CRITICAL does not conjure a security lab — it only raises the bar for a
    // concern that genuinely exists.
    const requiredStrength = requiredStrengthFor(input.qualityPreference);
    const actualStrength = strengthOfResult(result);
    const strengthShortfall =
      status === "PASS" &&
      depthSensitiveChecks.has(check) &&
      raisedBy === "CANDIDATE_EVIDENCE" &&
      depthShortfallBites(check, input.concerns) &&
      !meetsStrength(actualStrength, requiredStrength);
    const covered =
      status === "PASS" && coverage === "UNSUPPORTED"
        ? "UNSUPPORTED"
        : partialUnderMaterial || strengthShortfall
          ? "UNKNOWN"
          : status;
    obligations.push({
      id: `${check}.${capability.id.split(".")[1] ?? "EVIDENCE"}`,
      check,
      origin: { kind: "PLAN_REQUIRED", raisedBy, reason },
      material: true,
      candidateId,
      diffDigest,
      requiredCapability: capability.id,
      producedBy: capability.id,
      status: covered,
      coverage,
      evidence: [
        ...result.evidence,
        ...(partialUnderMaterial
          ? [
              `${capability.id} ran and found no signal, but only PARTIAL coverage of this material — its generic shapes transfer while the language's own idioms are not modelled. A no-signal result under partial coverage is preserved as evidence and is NOT a resolution of a material obligation.`,
            ]
          : []),
        ...(strengthShortfall
          ? [
              `the requested assurance depth (${input.qualityPreference ?? "BALANCED"}) requires at least ${requiredStrength} evidence for ${check}; ${capability.id} produced ${actualStrength} evidence (provenance ${result.provenance}). The finding is preserved, but a depth request is a demand for confidence and is not satisfied by weaker evidence.`,
            ]
          : []),
      ],
      justification:
        covered === "PASS"
          ? `${capability.id} established: ${capability.establishes}`
          : covered === "UNSUPPORTED"
            ? `${capability.id} could not read the material this obligation is about (coverage ${coverage}); it does not establish ${capability.doesNotEstablish}`
            : partialUnderMaterial
              ? `${capability.id} passed under PARTIAL coverage; partial analysis does not establish ${check} for this candidate, so the obligation stays unresolved`
              : strengthShortfall
                ? `${capability.id} passed with ${actualStrength} evidence, below the ${requiredStrength} depth requested for this task; the obligation stays unresolved rather than being downgraded silently`
                : `${check} was required and ${capability.id} resolved it ${covered}`,
    });
  }

  // Deterministic evidence raises its own obligation, plan or no plan (trust invariant A).
  for (const [dimension, result] of Object.entries(report) as Array<
    [QualityDimension, QualityCheckResult]
  >) {
    const check = dimensionCheck.get(dimension) ?? "UNKNOWN_CHECK";
    // Invariant A applies to EVERY dimension, including the ones that only report information
    // today. Maintainability and TestQuality currently produce nothing worse than WARN, so this
    // changes no present behaviour — but if either ever gains a deterministic FAIL, it blocks
    // without anyone having to remember to add it to a list.
    const deterministicFail =
      result.state === "FAIL" &&
      (result.provenance === "DETERMINISTIC" || result.provenance === "MEASURED");
    // Broad Security/Resilience UNKNOWN/NOT_CHECKED states are projections of several questions.
    // They cannot authoritatively block or resolve trust; the exact concern/question obligations
    // above own that decision. Deterministic FAIL remains authoritative for every dimension.
    if (!deterministicFail) continue;
    // Already enumerated from the plan above, where it is material by construction.
    if (claimed.has(dimension)) continue;
    obligations.push({
      id: `${dimension}.DETERMINISTIC_EVIDENCE`,
      check,
      origin: {
        kind: "DETERMINISTIC_EVIDENCE",
        dimension,
        reason: `${dimension} produced a deterministic ${result.provenance} FAIL; a broken rule is evidence, not a planner preference`,
      },
      material: true,
      candidateId,
      diffDigest,
      requiredCapability: null,
      producedBy: null,
      status: statusFromQuality(result),
      coverage: result.coverage ?? "NOT_APPLICABLE",
      evidence: result.evidence,
      justification: `${dimension} FAILed deterministically; promotion is blocked whether or not the plan predicted this dimension`,
    });
  }

  // Concern-level obligations (findings C3/H1/H2). Additive: these are raised from structural
  // evidence in the diff's added code, so they exist independently of which path keywords the
  // planner happened to match — which is what stops file naming from being a security boundary.
  obligations.push(...deriveConcernObligations(input, candidateId, diffDigest));

  return obligations;
};

/** The material obligations that are not resolved. Empty means promotion is not obligation-blocked. */
export const unresolvedObligations = (obligations: AssuranceObligation[]): AssuranceObligation[] =>
  obligations.filter((obligation) => obligation.material && !isResolved(obligation.status));
