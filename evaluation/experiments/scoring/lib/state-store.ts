// Durable campaign state: slot reservation, crash recovery, and append-preserving evidence.
//
// THE CENTRAL SAFETY PROPERTY, stated once so it is never lost in the details:
//
//   A provider invocation that MAY have been billed is never repeated automatically.
//
// The runner writes a `provider start intent` record, flushed to disk, immediately BEFORE it spawns
// a participant. So on restart there are exactly two possibilities for any attempt, and they are
// distinguishable from durable state alone:
//
//   * no intent record  -> the spawn provably never happened; the slot is safe to reclaim and run.
//   * intent, no outcome -> the spawn MAY have happened and MAY have been billed. This is the
//                           ambiguous case. It becomes RECOVERY_REQUIRED and stops the campaign for
//                           that slot until a human adjudicates it. The runner never guesses
//                           "probably not billed" -- that guess is exactly how an experiment
//                           silently double-pays and double-counts.
//
// Evidence is append-only. An observation, once written, is never overwritten or deleted -- not even
// when the protocol legitimately authorizes an infrastructure rerun (EXPERIMENT_PROTOCOL.md 17.2
// requires the original record be preserved). A rerun appends `obs-002`; `obs-001` stays forever.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, readRecord, writeRecordExclusive, type ReadOutcome } from "./atomic-io";
import { isWellFormedSlotId, type Arm, type RunSlot, type ScoringSchedule } from "./schedule";

export const RECORD_KINDS = {
  campaign: "maf-scoring/campaign",
  schedule: "maf-scoring/schedule",
  reservation: "maf-scoring/reservation",
  intent: "maf-scoring/provider-start-intent",
  attemptOutcome: "maf-scoring/attempt-outcome",
  observation: "maf-scoring/observation",
  adjudication: "maf-scoring/adjudication",
  rerunAuthorization: "maf-scoring/rerun-authorization",
} as const;

/** Default lease window. A reservation not refreshed within this is treated as abandoned. */
export const DEFAULT_LEASE_MS = 120_000;

export interface CampaignMetadata {
  campaignId: string;
  createdAt: string;
  suiteTag: string;
  suiteSha: string;
  protocolTag: string;
  protocolSha: string;
  /** The frozen statistical specification this campaign will be analysed under. */
  analysisTag: string;
  analysisSha: string;
  analysisVersion: string;
  runnerVersion: string;
  runnerTag: string;
  /** Null while the runner is not yet frozen; billed execution is impossible in that state. */
  runnerSha: string | null;
  /**
   * Whether this campaign may ever hold paid observations.
   *
   * A campaign created before the runner freeze has `runnerSha: null` -- there is no frozen runner
   * identity to bind its results to. Such a campaign is NON_BILLED_DEVELOPMENT and can never be
   * promoted: silently reusing it after the freeze would attribute paid observations to a runner
   * revision that did not exist when the campaign was created. Paid work requires a campaign
   * initialised after the freeze, whose runner identity is recorded up front and checked on every
   * resume.
   */
  billingMode: "NON_BILLED_DEVELOPMENT" | "PAID";
  scheduleDigest: string;
  totalSlots: number;
  /** Operator-authorized campaign spend ceiling. Null means billed execution is not authorized. */
  campaignCeilingUsd: number | null;
  protocolFreezeAuthority: "GIT_TAG";
  protocolFrozen: true;
  knownSourceMetadataNote: string;
}

export interface ReservationRecord {
  slotId: string;
  slotDigest: string;
  generation: number;
  owner: string;
  pid: number;
  hostname: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseMs: number;
}

export interface ProviderStartIntentRecord {
  slotId: string;
  slotDigest: string;
  generation: number;
  attemptId: string;
  attemptNumber: number;
  owner: string;
  /** Written and flushed BEFORE the spawn. Its presence means "a paid call may exist". */
  declaredAt: string;
  requestedModel: string;
  effort: string;
  arm: Arm;
}

export interface AttemptOutcomeRecord {
  slotId: string;
  attemptId: string;
  generation: number;
  finishedAt: string;
  /** Whatever the attempt driver concluded; opaque to the store. */
  classification: string;
  costUsd: number | null;
  costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
}

export interface ObservationRecord<TProvenance = unknown> {
  slotId: string;
  slotDigest: string;
  generation: number;
  observationIndex: number;
  taskId: string;
  arm: Arm;
  replicate: number;
  randomizationPosition: number;
  sequencePosition: number;
  recordedAt: string;
  /**
   * The frozen analysis specification in force when this observation was recorded. Optional only so
   * that records written before Analysis v1 existed remain readable; the participant runner always
   * populates it, and `checkProvenanceCompleteness` requires it on the provenance record.
   */
  analysisTag?: string;
  analysisSha?: string;
  analysisVersion?: string;
  /** True when this observation is an infrastructure failure (protocol 17.1). */
  infrastructureInvalid: boolean;
  dvs: boolean;
  runValidity: "VALID" | "INVALID";
  costUsd: number | null;
  costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
  /** The full scoring provenance record. */
  provenance: TProvenance;
  /** Set when this observation supersedes an earlier infrastructure-invalid one. */
  supersedesObservationIndex?: number;
}

export interface AdjudicationRecord {
  slotId: string;
  generation: number;
  attemptId: string;
  decidedAt: string;
  operator: string;
  /** The human's determination about whether the ambiguous attempt was actually billed. */
  billedDetermination: "CONFIRMED_BILLED" | "CONFIRMED_NOT_BILLED" | "UNKNOWN_ASSUME_BILLED";
  /** Whether the slot may be executed again. False leaves the slot permanently unresolved. */
  allowRetry: boolean;
  reason: string;
}

export interface RerunAuthorizationRecord {
  slotId: string;
  authorizationIndex: number;
  authorizedAt: string;
  operator: string;
  supersedesObservationIndex: number;
  reason: string;
  /** Proof, copied from the stored observation, that the original was infrastructure-invalid. */
  eligibilityEvidence: {
    infrastructureInvalid: true;
    runValidity: "INVALID";
    classification: string;
  };
}

export type SlotStatus =
  | "PLANNED"
  | "RESERVED_BUSY"
  | "RECLAIMABLE"
  | "RECOVERY_REQUIRED"
  | "UNRESOLVED_BLOCKED"
  | "COMPLETE"
  | "CORRUPT";

export interface SlotState {
  slotId: string;
  status: SlotStatus;
  generation: number;
  observations: ObservationRecord[];
  adjudications: AdjudicationRecord[];
  rerunAuthorizations: RerunAuthorizationRecord[];
  danglingIntents: ProviderStartIntentRecord[];
  reservation: ReservationRecord | null;
  corruption: string[];
  detail: string;
}

const nowIso = (): string => new Date().toISOString();

/** Lists a directory's `.json` files in sorted order; missing directory reads as empty. */
const listJsonFiles = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export interface ScoringStateStoreOptions {
  root: string;
  /** Injectable clock so lease expiry is deterministic under test. */
  now?: () => number;
  leaseMs?: number;
  /** Identifies this process. Two runners must never share one. */
  owner?: string;
}

export class ScoringStateStore {
  private readonly root: string;
  private readonly now: () => number;
  readonly leaseMs: number;
  readonly owner: string;

  constructor(options: ScoringStateStoreOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.owner = options.owner ?? randomUUID();
  }

  private slotDir(slotId: string): string {
    if (!isWellFormedSlotId(slotId)) {
      throw new Error(`refusing to use malformed slot id as a path segment: ${slotId}`);
    }
    return path.join(this.root, "slots", slotId);
  }

  private campaignPath(): string {
    return path.join(this.root, "campaign.json");
  }

  private schedulePath(): string {
    return path.join(this.root, "schedule.json");
  }

  // ---------------------------------------------------------------- campaign

  /**
   * Creates a campaign, refusing to touch one that already exists.
   *
   * Overwriting was a real hazard: `init` on an existing directory silently replaced campaign.json
   * and schedule.json, which would orphan every recorded observation under a new campaign identity
   * and reset the spend accounting the cost gate depends on -- destroying paid evidence with a
   * command that reads like a no-op. Exclusive create makes that impossible; reopening an existing
   * campaign is `openCampaign`, which validates identity instead of replacing it.
   */
  async createCampaign(
    metadata: CampaignMetadata,
  ): Promise<{ created: boolean; existing: CampaignMetadata | null; detail: string }> {
    await ensureDirectory(this.root);
    const { created } = await writeRecordExclusive(
      this.campaignPath(),
      RECORD_KINDS.campaign,
      metadata,
    );
    if (created) return { created: true, existing: null, detail: "campaign created" };
    const outcome = await this.readCampaign();
    return {
      created: false,
      existing: outcome.status === "OK" ? outcome.record.payload : null,
      detail:
        outcome.status === "OK"
          ? `a campaign already exists here (id ${outcome.record.payload.campaignId}, created ` +
            `${outcome.record.payload.createdAt}). Refusing to overwrite it; use resume to continue it.`
          : `a campaign file already exists here but is ${outcome.status}; refusing to overwrite it`,
    };
  }

  /**
   * Reopens an existing campaign, proving its immutable identity still matches the frozen inputs.
   *
   * A campaign collected under a different suite, protocol, analysis or schedule is a different
   * experiment; continuing it as if it were this one would silently merge incompatible evidence.
   */
  async openCampaign(expected: {
    suiteSha: string;
    protocolSha: string;
    analysisSha: string;
    scheduleDigest: string;
    /**
     * Runner identity to require. Supplied only when the caller intends PAID execution: a campaign
     * that will spend money must be bound to the runner freeze that owns it, so results can never
     * be silently migrated across runner revisions.
     */
    runnerTag?: string;
    runnerSha?: string | null;
    requirePaid?: boolean;
  }): Promise<
    | { opened: true; campaign: CampaignMetadata }
    | { opened: false; campaign: CampaignMetadata | null; mismatches: string[]; detail: string }
  > {
    const outcome = await this.readCampaign();
    if (outcome.status !== "OK") {
      return {
        opened: false,
        campaign: null,
        mismatches: [],
        detail: `no readable campaign at this path (${outcome.status}); run init first`,
      };
    }
    const campaign = outcome.record.payload;
    const mismatches: string[] = [];
    const compare = (label: string, actual: string, wanted: string): void => {
      if (actual !== wanted) mismatches.push(`${label}: stored=${actual} expected=${wanted}`);
    };
    compare("suiteSha", campaign.suiteSha, expected.suiteSha);
    compare("protocolSha", campaign.protocolSha, expected.protocolSha);
    compare("analysisSha", campaign.analysisSha, expected.analysisSha);
    compare("scheduleDigest", campaign.scheduleDigest, expected.scheduleDigest);

    if (expected.requirePaid === true) {
      if (campaign.billingMode !== "PAID") {
        mismatches.push(
          `billingMode: stored=${campaign.billingMode} expected=PAID. This campaign was created ` +
            "before the runner freeze and has no frozen runner identity to bind paid observations " +
            "to; initialise a new campaign rather than promoting a development one",
        );
      }
      if (expected.runnerTag !== undefined) {
        compare("runnerTag", campaign.runnerTag, expected.runnerTag);
      }
      if (expected.runnerSha !== undefined) {
        compare("runnerSha", String(campaign.runnerSha), String(expected.runnerSha));
      }
    }
    if (mismatches.length > 0) {
      return {
        opened: false,
        campaign,
        mismatches,
        detail:
          "the stored campaign was collected under different frozen inputs and cannot be resumed " +
          `as this one: ${mismatches.join("; ")}`,
      };
    }
    return { opened: true, campaign };
  }

  async readCampaign(): Promise<ReadOutcome<CampaignMetadata>> {
    return readRecord<CampaignMetadata>(this.campaignPath(), RECORD_KINDS.campaign);
  }

  /** Writes the schedule once. Like the campaign, an existing schedule is never replaced. */
  async createSchedule(
    schedule: ScoringSchedule,
  ): Promise<{ created: boolean; matches: boolean; detail: string }> {
    await ensureDirectory(this.root);
    const { created } = await writeRecordExclusive(
      this.schedulePath(),
      RECORD_KINDS.schedule,
      schedule,
    );
    if (created) return { created: true, matches: true, detail: "schedule written" };
    const existing = await this.readSchedule();
    const matches =
      existing.status === "OK" &&
      existing.record.payload.scheduleDigest === schedule.scheduleDigest;
    return {
      created: false,
      matches,
      detail: matches
        ? "an identical schedule already exists here"
        : "a DIFFERENT schedule already exists here; refusing to overwrite recorded campaign state",
    };
  }

  async readSchedule(): Promise<ReadOutcome<ScoringSchedule>> {
    return readRecord<ScoringSchedule>(this.schedulePath(), RECORD_KINDS.schedule);
  }

  // ------------------------------------------------------------ slot reading

  private async readAllIn<T>(
    dir: string,
    kind: string,
  ): Promise<{ items: T[]; corrupt: string[] }> {
    const files = await listJsonFiles(dir);
    const items: T[] = [];
    const corrupt: string[] = [];
    for (const file of files) {
      const outcome = await readRecord<T>(path.join(dir, file), kind);
      if (outcome.status === "OK") items.push(outcome.record.payload);
      else if (outcome.status === "CORRUPT") corrupt.push(`${file}: ${outcome.detail}`);
    }
    return { items, corrupt };
  }

  /**
   * Derives a slot's authoritative state from durable evidence only.
   *
   * Reading order matters: corruption is checked before anything else, because a corrupt record makes
   * every downstream conclusion unsound, and an ambiguous started attempt is checked before
   * reservation liveness, because "may have been billed" outranks "someone else holds the lease".
   */
  async inspectSlot(slotId: string): Promise<SlotState> {
    const dir = this.slotDir(slotId);
    const observationsDir = path.join(dir, "observations");
    const intentsDir = path.join(dir, "intents");
    const outcomesDir = path.join(dir, "outcomes");
    const adjudicationsDir = path.join(dir, "adjudications");
    const authorizationsDir = path.join(dir, "rerun-authorizations");

    const observationsRead = await this.readAllIn<ObservationRecord>(
      observationsDir,
      RECORD_KINDS.observation,
    );
    const intentsRead = await this.readAllIn<ProviderStartIntentRecord>(
      intentsDir,
      RECORD_KINDS.intent,
    );
    const outcomesRead = await this.readAllIn<AttemptOutcomeRecord>(
      outcomesDir,
      RECORD_KINDS.attemptOutcome,
    );
    const adjudicationsRead = await this.readAllIn<AdjudicationRecord>(
      adjudicationsDir,
      RECORD_KINDS.adjudication,
    );
    const authorizationsRead = await this.readAllIn<RerunAuthorizationRecord>(
      authorizationsDir,
      RECORD_KINDS.rerunAuthorization,
    );

    const corruption = [
      ...observationsRead.corrupt.map((c) => `observations/${c}`),
      ...intentsRead.corrupt.map((c) => `intents/${c}`),
      ...outcomesRead.corrupt.map((c) => `outcomes/${c}`),
      ...adjudicationsRead.corrupt.map((c) => `adjudications/${c}`),
      ...authorizationsRead.corrupt.map((c) => `rerun-authorizations/${c}`),
    ];

    const observations = observationsRead.items.sort(
      (a, b) => a.observationIndex - b.observationIndex,
    );
    const adjudications = adjudicationsRead.items;
    const rerunAuthorizations = authorizationsRead.items;

    // Generation is monotonic across a slot's whole life: every closed attempt generation either
    // produced an observation or was adjudicated.
    const generation = observations.length + adjudications.length;

    const base = {
      slotId,
      generation,
      observations,
      adjudications,
      rerunAuthorizations,
      reservation: null as ReservationRecord | null,
      corruption,
    };

    if (corruption.length > 0) {
      return {
        ...base,
        status: "CORRUPT",
        danglingIntents: [],
        detail:
          `slot ${slotId} has ${corruption.length} unreadable/corrupt record(s); a corrupt record ` +
          "is never counted as a completed run and execution is refused until it is resolved",
      };
    }

    const settledAttemptIds = new Set(outcomesRead.items.map((o) => o.attemptId));
    const adjudicatedAttemptIds = new Set(adjudications.map((a) => a.attemptId));
    const danglingIntents = intentsRead.items.filter(
      (intent) =>
        !settledAttemptIds.has(intent.attemptId) && !adjudicatedAttemptIds.has(intent.attemptId),
    );

    if (danglingIntents.length > 0) {
      return {
        ...base,
        status: "RECOVERY_REQUIRED",
        danglingIntents,
        detail:
          `slot ${slotId} has ${danglingIntents.length} attempt(s) that declared provider-start ` +
          "intent but never recorded an outcome. That call MAY have been billed. This slot is " +
          "fail-closed and requires explicit human adjudication before any further execution.",
      };
    }

    // Protocol 17.2: a rerun replaces an infrastructure-failed slot rather than adding to N.
    const owed = 1 + rerunAuthorizations.length - observations.length;
    if (owed <= 0) {
      return {
        ...base,
        status: "COMPLETE",
        danglingIntents: [],
        detail: `slot ${slotId} has ${observations.length} recorded observation(s) and owes none`,
      };
    }

    // An adjudication that refused a retry leaves the slot permanently unresolved, by design.
    const blockedByAdjudication = adjudications.filter((a) => !a.allowRetry);
    if (blockedByAdjudication.length > 0) {
      return {
        ...base,
        status: "UNRESOLVED_BLOCKED",
        danglingIntents: [],
        detail:
          `slot ${slotId} was adjudicated with allowRetry=false; it stays unresolved and is ` +
          "reported as such rather than being silently retried or silently dropped",
      };
    }

    const reservationOutcome = await this.readCurrentReservation(slotId, generation);
    if (reservationOutcome.corrupt) {
      return {
        ...base,
        status: "CORRUPT",
        danglingIntents: [],
        corruption: [...corruption, reservationOutcome.corrupt],
        detail: `slot ${slotId} has a corrupt reservation record`,
      };
    }
    const reservation = reservationOutcome.reservation;
    if (reservation === null) {
      return {
        ...base,
        status: "PLANNED",
        danglingIntents: [],
        detail: `slot ${slotId} is unclaimed and owes ${owed} observation(s)`,
      };
    }
    const ageMs = this.now() - Date.parse(reservation.heartbeatAt);
    if (ageMs <= reservation.leaseMs) {
      return {
        ...base,
        status: "RESERVED_BUSY",
        danglingIntents: [],
        reservation,
        detail: `slot ${slotId} is held by a live reservation (owner ${reservation.owner})`,
      };
    }
    return {
      ...base,
      status: "RECLAIMABLE",
      danglingIntents: [],
      reservation,
      detail:
        `slot ${slotId} has an expired reservation (${ageMs}ms since heartbeat) and NO ` +
        "provider-start intent, which proves no participant was ever spawned under it; " +
        "reclaiming cannot double-bill",
    };
  }

  /** Highest-numbered reservation attempt for the current generation, if any. */
  private async readCurrentReservation(
    slotId: string,
    generation: number,
  ): Promise<{ reservation: ReservationRecord | null; corrupt: string | null }> {
    const dir = path.join(this.slotDir(slotId), "reservations");
    const files = await listJsonFiles(dir);
    const prefix = `gen-${generation}`;
    const relevant = files.filter((name) => name.startsWith(`${prefix}.`)).sort();
    if (relevant.length === 0) return { reservation: null, corrupt: null };
    const newest = relevant[relevant.length - 1] as string;
    const outcome = await readRecord<ReservationRecord>(
      path.join(dir, newest),
      RECORD_KINDS.reservation,
    );
    if (outcome.status === "OK") return { reservation: outcome.record.payload, corrupt: null };
    if (outcome.status === "CORRUPT") {
      return { reservation: null, corrupt: `reservations/${newest}: ${outcome.detail}` };
    }
    return { reservation: null, corrupt: null };
  }

  // ------------------------------------------------------------- reservation

  /**
   * Atomically claims a slot for execution.
   *
   * The mutex is the filesystem's exclusive-create guarantee: of any number of concurrent callers,
   * the OS lets exactly one create a given reservation file. A caller that loses the race is told so
   * and MUST NOT spawn anything. Takeover of an expired lease walks an increasing suffix, so the
   * takeover itself is also decided by exclusive create rather than by read-then-write.
   */
  async claimSlot(
    slot: RunSlot,
    options: { maxTakeovers?: number } = {},
  ): Promise<
    | { claimed: true; reservation: ReservationRecord; reservationFile: string }
    | { claimed: false; reason: SlotStatus; detail: string }
  > {
    const state = await this.inspectSlot(slot.slotId);
    if (state.status === "COMPLETE") {
      return { claimed: false, reason: "COMPLETE", detail: state.detail };
    }
    if (state.status === "RECOVERY_REQUIRED") {
      return { claimed: false, reason: "RECOVERY_REQUIRED", detail: state.detail };
    }
    if (state.status === "CORRUPT") {
      return { claimed: false, reason: "CORRUPT", detail: state.detail };
    }
    if (state.status === "UNRESOLVED_BLOCKED") {
      return { claimed: false, reason: "UNRESOLVED_BLOCKED", detail: state.detail };
    }
    if (state.status === "RESERVED_BUSY") {
      return { claimed: false, reason: "RESERVED_BUSY", detail: state.detail };
    }

    const generation = state.generation;
    const dir = path.join(this.slotDir(slot.slotId), "reservations");
    const maxTakeovers = options.maxTakeovers ?? 32;

    for (let attempt = 0; attempt <= maxTakeovers; attempt += 1) {
      const fileName =
        attempt === 0 ? `gen-${generation}.json` : `gen-${generation}.t${attempt}.json`;
      const filePath = path.join(dir, fileName);
      const timestamp = new Date(this.now()).toISOString();
      const reservation: ReservationRecord = {
        slotId: slot.slotId,
        slotDigest: slot.slotDigest,
        generation,
        owner: this.owner,
        pid: process.pid,
        hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown",
        claimedAt: timestamp,
        heartbeatAt: timestamp,
        leaseMs: this.leaseMs,
      };
      const { created } = await writeRecordExclusive(
        filePath,
        RECORD_KINDS.reservation,
        reservation,
      );
      if (created) {
        return { claimed: true, reservation, reservationFile: filePath };
      }
      // Someone already holds this rung. If their lease is live, we lose; otherwise try the next.
      const existing = await readRecord<ReservationRecord>(filePath, RECORD_KINDS.reservation);
      if (existing.status === "CORRUPT") {
        return {
          claimed: false,
          reason: "CORRUPT",
          detail: `reservation ${fileName} is corrupt: ${existing.detail}`,
        };
      }
      if (existing.status === "OK") {
        const ageMs = this.now() - Date.parse(existing.record.payload.heartbeatAt);
        if (ageMs <= existing.record.payload.leaseMs) {
          return {
            claimed: false,
            reason: "RESERVED_BUSY",
            detail: `slot ${slot.slotId} is held by a live reservation (owner ${existing.record.payload.owner})`,
          };
        }
      }
    }
    return {
      claimed: false,
      reason: "RESERVED_BUSY",
      detail: `exhausted ${maxTakeovers} takeover attempts for slot ${slot.slotId}`,
    };
  }

  /**
   * The lease exists to cover exactly ONE window: claim -> provider-start intent.
   *
   * Before this repair the store also exposed a `heartbeat()` that nothing ever called, which made
   * the lease look like it protected long-running work when it did not. It does not need to. Once an
   * intent record exists, `inspectSlot` reports RECOVERY_REQUIRED regardless of lease age -- the
   * dangling-intent check runs BEFORE any liveness check -- so a 30-minute participant run can never
   * be reclaimed out from under itself no matter how stale its reservation looks.
   *
   * That leaves only the pre-intent window, which the participant runner now keeps to two exclusive
   * file creates by declaring intent immediately after claiming and before any slow work. A lease
   * that expires in that window is genuinely abandoned, and reclaiming it is provably safe because
   * the absence of an intent record is durable proof no participant was ever spawned.
   *
   * So there is nothing to heartbeat, and the dead method is gone rather than left as a misleading
   * affordance.
   */
  readonly leaseCoversPreIntentWindowOnly = true;

  // --------------------------------------------------- provider start intent

  /**
   * Declares that a provider invocation is about to be spawned, durably, BEFORE the spawn.
   *
   * Everything about post-crash safety depends on this record hitting the disk first. Callers must
   * await it and must not spawn if it throws.
   */
  async declareProviderStartIntent(input: {
    slot: RunSlot;
    generation: number;
    attemptNumber: number;
    requestedModel: string;
    effort: string;
  }): Promise<ProviderStartIntentRecord> {
    const attemptId = `${input.slot.slotId}--g${input.generation}-a${input.attemptNumber}-${randomUUID()}`;
    const record: ProviderStartIntentRecord = {
      slotId: input.slot.slotId,
      slotDigest: input.slot.slotDigest,
      generation: input.generation,
      attemptId,
      attemptNumber: input.attemptNumber,
      owner: this.owner,
      declaredAt: nowIso(),
      requestedModel: input.requestedModel,
      effort: input.effort,
      arm: input.slot.arm,
    };
    const filePath = path.join(this.slotDir(input.slot.slotId), "intents", `${attemptId}.json`);
    const { created } = await writeRecordExclusive(filePath, RECORD_KINDS.intent, record);
    if (!created) throw new Error(`provider start intent already exists for attempt ${attemptId}`);
    return record;
  }

  /** Settles an attempt, which is what makes its intent no longer ambiguous. */
  async recordAttemptOutcome(record: AttemptOutcomeRecord): Promise<void> {
    const filePath = path.join(this.slotDir(record.slotId), "outcomes", `${record.attemptId}.json`);
    const { created } = await writeRecordExclusive(filePath, RECORD_KINDS.attemptOutcome, record);
    if (!created) throw new Error(`attempt outcome already recorded for ${record.attemptId}`);
  }

  // ------------------------------------------------------------ observations

  /** Appends a finalized observation. Exclusive create: an index is never rewritten. */
  async appendObservation<T>(
    observation: Omit<ObservationRecord<T>, "observationIndex" | "recordedAt"> & {
      observationIndex?: number;
    },
  ): Promise<ObservationRecord<T>> {
    const state = await this.inspectSlot(observation.slotId);
    const index = observation.observationIndex ?? state.observations.length + 1;
    const record = {
      ...observation,
      observationIndex: index,
      recordedAt: nowIso(),
    } as ObservationRecord<T>;
    const filePath = path.join(
      this.slotDir(observation.slotId),
      "observations",
      `obs-${String(index).padStart(3, "0")}.json`,
    );
    const { created } = await writeRecordExclusive(filePath, RECORD_KINDS.observation, record);
    if (!created) {
      throw new Error(
        `observation ${index} already exists for slot ${observation.slotId}; observations are append-only and never overwritten`,
      );
    }
    return record;
  }

  // ------------------------------------------------------------ adjudication

  /** Records a human decision about an ambiguous, possibly-billed attempt. */
  async recordAdjudication(
    record: Omit<AdjudicationRecord, "decidedAt">,
  ): Promise<AdjudicationRecord> {
    const full: AdjudicationRecord = { ...record, decidedAt: nowIso() };
    const filePath = path.join(
      this.slotDir(record.slotId),
      "adjudications",
      `${record.attemptId}.json`,
    );
    const { created } = await writeRecordExclusive(filePath, RECORD_KINDS.adjudication, full);
    if (!created) throw new Error(`attempt ${record.attemptId} has already been adjudicated`);
    return full;
  }

  /**
   * Authorizes ONE infrastructure rerun of a slot (EXPERIMENT_PROTOCOL.md 17.2).
   *
   * Eligibility is proven from the STORED observation, not from the operator's assertion: a
   * participant/arm failure is never rerunnable however unlucky it looks, because rerunning until an
   * arm succeeds biases that arm's DVS rate upward. The original observation is untouched.
   */
  async authorizeInfrastructureRerun(input: {
    slotId: string;
    operator: string;
    reason: string;
  }): Promise<
    { authorized: true; record: RerunAuthorizationRecord } | { authorized: false; detail: string }
  > {
    const state = await this.inspectSlot(input.slotId);
    if (state.status === "CORRUPT") {
      return {
        authorized: false,
        detail: `slot ${input.slotId} has corrupt records: ${state.detail}`,
      };
    }
    const latest = state.observations[state.observations.length - 1];
    if (!latest) {
      return {
        authorized: false,
        detail: `slot ${input.slotId} has no recorded observation to supersede; nothing is eligible for rerun`,
      };
    }
    if (state.rerunAuthorizations.length >= state.observations.length) {
      return {
        authorized: false,
        detail: `slot ${input.slotId} already has an open rerun authorization`,
      };
    }
    if (!latest.infrastructureInvalid || latest.runValidity !== "INVALID") {
      return {
        authorized: false,
        detail:
          `slot ${input.slotId} observation ${latest.observationIndex} is not an infrastructure ` +
          `failure (infrastructureInvalid=${latest.infrastructureInvalid}, runValidity=${latest.runValidity}). ` +
          "EXPERIMENT_PROTOCOL.md 17.1/17.2 permit a rerun ONLY for experiment infrastructure " +
          "failure; an arm's own failure is a valid non-DVS run and is never rerun.",
      };
    }
    const authorizationIndex = state.rerunAuthorizations.length + 1;
    const record: RerunAuthorizationRecord = {
      slotId: input.slotId,
      authorizationIndex,
      authorizedAt: nowIso(),
      operator: input.operator,
      supersedesObservationIndex: latest.observationIndex,
      reason: input.reason,
      eligibilityEvidence: {
        infrastructureInvalid: true,
        runValidity: "INVALID",
        classification: String(
          (latest.provenance as { failureClassification?: unknown } | undefined)
            ?.failureClassification ?? "INFRA_FAILURE",
        ),
      },
    };
    const filePath = path.join(
      this.slotDir(input.slotId),
      "rerun-authorizations",
      `auth-${String(authorizationIndex).padStart(3, "0")}.json`,
    );
    const { created } = await writeRecordExclusive(
      filePath,
      RECORD_KINDS.rerunAuthorization,
      record,
    );
    if (!created) {
      return {
        authorized: false,
        detail: `rerun authorization ${authorizationIndex} already exists`,
      };
    }
    return { authorized: true, record };
  }

  // ---------------------------------------------------------------- campaign

  /** Inspects every slot in the schedule. Used by status, next-pending and aggregation. */
  async inspectAll(schedule: ScoringSchedule): Promise<SlotState[]> {
    const states: SlotState[] = [];
    for (const slot of schedule.slots) states.push(await this.inspectSlot(slot.slotId));
    return states;
  }
}
