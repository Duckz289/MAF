import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ScoringStateStore,
  RECORD_KINDS,
  type ObservationRecord,
} from "../evaluation/experiments/scoring/lib/state-store";
import { buildScoringSchedule, type RunSlot } from "../evaluation/experiments/scoring/lib/schedule";

const schedule = buildScoringSchedule({
  randomization: {
    seed: "test-seed",
    taskOrder: ["alpha-task", "beta-task"],
    armOrder: { "alpha-task": "NATIVE_FIRST", "beta-task": "MAF_FIRST" },
  },
  frozenTaskIds: ["alpha-task", "beta-task"],
  runsPerTask: 3,
});
const slot = schedule.slots[0] as RunSlot;

let root: string;
let clock: number;

const storeFor = (owner: string, leaseMs = 1000) =>
  new ScoringStateStore({ root, owner, leaseMs, now: () => clock });

const observationFor = (
  overrides: Partial<ObservationRecord> = {},
): Parameters<ScoringStateStore["appendObservation"]>[0] => ({
  slotId: slot.slotId,
  slotDigest: slot.slotDigest,
  generation: 0,
  taskId: slot.taskId,
  arm: slot.arm,
  replicate: slot.replicate,
  randomizationPosition: slot.randomizationPosition,
  sequencePosition: slot.sequencePosition,
  infrastructureInvalid: false,
  dvs: true,
  runValidity: "VALID",
  costUsd: 1.25,
  costStatus: "KNOWN",
  provenance: { failureClassification: "COMPLETED" },
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "maf-scoring-state-"));
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("slot lifecycle", () => {
  it("starts PLANNED and becomes COMPLETE after one observation", async () => {
    const store = storeFor("owner-a");
    expect((await store.inspectSlot(slot.slotId)).status).toBe("PLANNED");
    await store.appendObservation(observationFor());
    expect((await store.inspectSlot(slot.slotId)).status).toBe("COMPLETE");
  });

  it("refuses to claim a slot that is already COMPLETE", async () => {
    const store = storeFor("owner-a");
    await store.appendObservation(observationFor());
    const claim = await store.claimSlot(slot);
    expect(claim.claimed).toBe(false);
    expect(claim).toMatchObject({ reason: "COMPLETE" });
  });
});

describe("concurrent launch protection (Phase 5)", () => {
  it("lets exactly one of two simultaneous processes claim the same slot", async () => {
    const a = storeFor("process-a");
    const b = storeFor("process-b");
    const [first, second] = await Promise.all([a.claimSlot(slot), b.claimSlot(slot)]);
    const claimed = [first, second].filter((r) => r.claimed);
    expect(claimed).toHaveLength(1);
    const refused = [first, second].find((r) => !r.claimed);
    expect(refused).toMatchObject({ reason: "RESERVED_BUSY" });
  });

  it("lets exactly one of many simultaneous processes claim the same slot", async () => {
    const stores = Array.from({ length: 8 }, (_, i) => storeFor(`process-${i}`));
    const results = await Promise.all(stores.map((store) => store.claimSlot(slot)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("refuses a second claim from the same accidentally re-launched command", async () => {
    const store = storeFor("process-a");
    expect((await store.claimSlot(slot)).claimed).toBe(true);
    const again = await store.claimSlot(slot);
    expect(again.claimed).toBe(false);
    expect(again).toMatchObject({ reason: "RESERVED_BUSY" });
  });
});

describe("crash recovery (Phase 6)", () => {
  it("A: a crash BEFORE reservation leaves the slot cleanly PLANNED", async () => {
    const fresh = storeFor("restarted-process");
    expect((await fresh.inspectSlot(slot.slotId)).status).toBe("PLANNED");
  });

  it("B: a crash AFTER reservation but BEFORE spawn is safely reclaimable", async () => {
    const crashed = storeFor("crashed-process");
    expect((await crashed.claimSlot(slot)).claimed).toBe(true);

    clock += 5000; // lease expires with no provider-start intent ever written
    const restarted = storeFor("restarted-process");
    const state = await restarted.inspectSlot(slot.slotId);
    expect(state.status).toBe("RECLAIMABLE");
    expect(state.detail).toMatch(/no provider was ever spawned|NO\s+provider-start intent/iu);
    expect((await restarted.claimSlot(slot)).claimed).toBe(true);
  });

  it("C/D: a crash AFTER provider-start intent is AMBIGUOUS and fails closed", async () => {
    const crashed = storeFor("crashed-process");
    const claim = await crashed.claimSlot(slot);
    expect(claim.claimed).toBe(true);
    await crashed.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });

    clock += 100_000; // the lease is long expired; the ambiguity is not
    const restarted = storeFor("restarted-process");
    const state = await restarted.inspectSlot(slot.slotId);
    expect(state.status).toBe("RECOVERY_REQUIRED");
    expect(state.danglingIntents).toHaveLength(1);
    expect(state.detail).toMatch(/MAY have been billed/u);

    const reclaim = await restarted.claimSlot(slot);
    expect(reclaim.claimed).toBe(false);
    expect(reclaim).toMatchObject({ reason: "RECOVERY_REQUIRED" });
  });

  it("E: an attempt that recorded its outcome is no longer ambiguous", async () => {
    const store = storeFor("process-a");
    await store.claimSlot(slot);
    const intent = await store.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });
    await store.recordAttemptOutcome({
      slotId: slot.slotId,
      attemptId: intent.attemptId,
      generation: 0,
      finishedAt: new Date(clock).toISOString(),
      classification: "COMPLETED",
      costUsd: 1.5,
      costStatus: "KNOWN",
    });
    const state = await store.inspectSlot(slot.slotId);
    expect(state.status).not.toBe("RECOVERY_REQUIRED");
    expect(state.danglingIntents).toHaveLength(0);
  });

  it("I/J: a fresh process after a completed observation sees COMPLETE and never re-runs it", async () => {
    const first = storeFor("process-a");
    await first.claimSlot(slot);
    const intent = await first.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });
    await first.recordAttemptOutcome({
      slotId: slot.slotId,
      attemptId: intent.attemptId,
      generation: 0,
      finishedAt: new Date(clock).toISOString(),
      classification: "COMPLETED",
      costUsd: 1.5,
      costStatus: "KNOWN",
    });
    await first.appendObservation(observationFor());

    clock += 10_000_000; // simulate a machine restart much later
    const rebooted = storeFor("rebooted-process");
    expect((await rebooted.inspectSlot(slot.slotId)).status).toBe("COMPLETE");
    expect((await rebooted.claimSlot(slot)).claimed).toBe(false);
  });

  it("an adjudicated ambiguous attempt unblocks the slot only when retry is allowed", async () => {
    const store = storeFor("process-a");
    await store.claimSlot(slot);
    const intent = await store.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });
    clock += 100_000;

    await store.recordAdjudication({
      slotId: slot.slotId,
      generation: 0,
      attemptId: intent.attemptId,
      operator: "auditor",
      billedDetermination: "CONFIRMED_NOT_BILLED",
      allowRetry: true,
      reason: "provider dashboard shows no call for this window",
    });
    const state = await storeFor("next-process").inspectSlot(slot.slotId);
    expect(state.status).toBe("PLANNED");
    // The ambiguous intent record itself is preserved, never erased.
    const preserved = await readFile(
      path.join(root, "slots", slot.slotId, "intents", `${intent.attemptId}.json`),
      "utf8",
    );
    expect(preserved).toContain(intent.attemptId);
  });

  it("an adjudication refusing retry leaves the slot permanently UNRESOLVED_BLOCKED", async () => {
    const store = storeFor("process-a");
    await store.claimSlot(slot);
    const intent = await store.declareProviderStartIntent({
      slot,
      generation: 0,
      attemptNumber: 1,
      requestedModel: "claude-sonnet-5",
      effort: "high",
    });
    await store.recordAdjudication({
      slotId: slot.slotId,
      generation: 0,
      attemptId: intent.attemptId,
      operator: "auditor",
      billedDetermination: "CONFIRMED_BILLED",
      allowRetry: false,
      reason: "the call was billed and produced no usable candidate; do not spend again",
    });
    const state = await store.inspectSlot(slot.slotId);
    expect(state.status).toBe("UNRESOLVED_BLOCKED");
    expect((await store.claimSlot(slot)).claimed).toBe(false);
  });
});

describe("atomic and append-preserving persistence (Phase 7/8)", () => {
  it("never overwrites an existing observation index", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(observationFor());
    await expect(
      store.appendObservation({ ...observationFor(), observationIndex: 1 }),
    ).rejects.toThrow(/append-only and never overwritten/u);
  });

  it("treats a truncated record as CORRUPT rather than as a completed run", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(observationFor());
    const file = path.join(root, "slots", slot.slotId, "observations", "obs-001.json");
    await writeFile(file, '{"envelopeVersion":1,"kind":', "utf8");
    const state = await store.inspectSlot(slot.slotId);
    expect(state.status).toBe("CORRUPT");
    expect(state.observations).toHaveLength(0);
  });

  it("detects a tampered record whose JSON is still valid", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(observationFor({ dvs: false }));
    const file = path.join(root, "slots", slot.slotId, "observations", "obs-001.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      payload: { dvs: boolean };
    };
    parsed.payload.dvs = true; // flip the result without recomputing the checksum
    await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");

    const state = await store.inspectSlot(slot.slotId);
    expect(state.status).toBe("CORRUPT");
    expect(state.corruption.join(" ")).toMatch(/checksum mismatch/u);
  });

  it("refuses to execute a slot holding a corrupt record", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(observationFor());
    await writeFile(
      path.join(root, "slots", slot.slotId, "observations", "obs-001.json"),
      "not json at all",
      "utf8",
    );
    const claim = await store.claimSlot(slot);
    expect(claim.claimed).toBe(false);
    expect(claim).toMatchObject({ reason: "CORRUPT" });
  });

  it("round-trips a campaign and a schedule record", async () => {
    const store = storeFor("process-a");
    await store.writeSchedule(schedule);
    const read = await store.readSchedule();
    expect(read.status).toBe("OK");
    if (read.status === "OK") {
      expect(read.record.payload.scheduleDigest).toBe(schedule.scheduleDigest);
    }
  });

  it("rejects a record read under the wrong kind", async () => {
    const store = storeFor("process-a");
    await store.writeSchedule(schedule);
    const { readRecord } = await import("../evaluation/experiments/scoring/lib/atomic-io");
    const wrong = await readRecord(path.join(root, "schedule.json"), RECORD_KINDS.campaign);
    expect(wrong.status).toBe("CORRUPT");
  });
});

describe("infrastructure rerun policy (Phase 8)", () => {
  it("refuses to rerun a participant/arm failure however unlucky it looks", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(
      observationFor({ dvs: false, runValidity: "VALID", infrastructureInvalid: false }),
    );
    const result = await store.authorizeInfrastructureRerun({
      slotId: slot.slotId,
      operator: "operator",
      reason: "it failed and I would like a better number",
    });
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.detail).toMatch(/never rerun|not an infrastructure/u);
  });

  it("authorizes a rerun of an infrastructure-invalid observation and preserves the original", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(
      observationFor({
        dvs: false,
        runValidity: "INVALID",
        infrastructureInvalid: true,
        provenance: { failureClassification: "PROVIDER_FAILURE" },
      }),
    );
    expect((await store.inspectSlot(slot.slotId)).status).toBe("COMPLETE");

    const result = await store.authorizeInfrastructureRerun({
      slotId: slot.slotId,
      operator: "operator",
      reason: "provider outage confirmed on the status page",
    });
    expect(result.authorized).toBe(true);

    // The slot reopens for exactly one more observation...
    const reopened = await store.inspectSlot(slot.slotId);
    expect(reopened.status).toBe("PLANNED");
    // ...and the original invalid evidence is still there, untouched.
    expect(reopened.observations).toHaveLength(1);
    expect(reopened.observations[0]?.infrastructureInvalid).toBe(true);

    await store.appendObservation(observationFor({ generation: 1, supersedesObservationIndex: 1 }));
    const after = await store.inspectSlot(slot.slotId);
    expect(after.status).toBe("COMPLETE");
    expect(after.observations).toHaveLength(2);
    expect(after.observations[0]?.infrastructureInvalid).toBe(true);
    expect(after.observations[1]?.dvs).toBe(true);
  });

  it("refuses a second open rerun authorization", async () => {
    const store = storeFor("process-a");
    await store.appendObservation(
      observationFor({ runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
    );
    expect(
      (
        await store.authorizeInfrastructureRerun({
          slotId: slot.slotId,
          operator: "op",
          reason: "outage",
        })
      ).authorized,
    ).toBe(true);
    const second = await store.authorizeInfrastructureRerun({
      slotId: slot.slotId,
      operator: "op",
      reason: "outage again",
    });
    expect(second.authorized).toBe(false);
  });

  it("refuses a rerun when no observation exists to supersede", async () => {
    const store = storeFor("process-a");
    const result = await store.authorizeInfrastructureRerun({
      slotId: slot.slotId,
      operator: "op",
      reason: "nothing here",
    });
    expect(result.authorized).toBe(false);
  });
});
