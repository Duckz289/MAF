// Crash-safe record persistence for scoring evidence.
//
// Scoring records are paid evidence: each one may represent up to $8 of provider spend that can
// never be re-collected identically. Two failure modes matter more than performance here.
//
//   1. A half-written file that parses as valid JSON. Guarded by writing to a temp file, flushing it
//      to disk, and only then renaming into place. `fs.rename` is atomic within a volume on both
//      POSIX and Windows (libuv issues MoveFileExW with MOVEFILE_REPLACE_EXISTING), so a reader
//      observes either the old bytes or the new bytes, never a mixture.
//   2. A file that is byte-damaged but still parses -- truncation at a record boundary, a partial
//      flush, storage corruption. JSON validity alone cannot detect that, so every record carries a
//      checksum over its own payload plus an explicit completion marker. A record failing either
//      check is reported as CORRUPT and is NEVER counted as a completed run.
//
// Directory fsync is deliberately not attempted: it is a no-op on Windows and Node exposes no
// portable way to do it. The stronger guarantee this module actually relies on is the atomic rename,
// which does not require the directory entry to be durable to be correct on restart -- a lost rename
// leaves the PREVIOUS state, which every reader here treats as "not yet written".

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const RECORD_ENVELOPE_VERSION = 1;

export interface RecordEnvelope<T> {
  envelopeVersion: number;
  /** Discriminates record kinds so a misfiled record cannot be silently read as another type. */
  kind: string;
  writtenAt: string;
  /** sha256 over the canonical serialization of `payload`. */
  checksum: string;
  /** Written last within the payload object; its absence marks an incomplete record. */
  recordComplete: true;
  payload: T;
}

export type ReadOutcome<T> =
  | { status: "OK"; record: RecordEnvelope<T> }
  | { status: "MISSING" }
  | { status: "CORRUPT"; detail: string };

/**
 * Canonical JSON with sorted object keys, so the checksum depends on VALUES rather than on key
 * insertion order. Without this, re-serializing an identical record could produce a different
 * checksum and a healthy record would be misreported as corrupt.
 */
export const canonicalize = (value: unknown): string => {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const entries = Object.entries(node as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
  };
  return JSON.stringify(walk(value));
};

export const checksumOf = (payload: unknown): string =>
  createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");

export const buildEnvelope = <T>(kind: string, payload: T): RecordEnvelope<T> => ({
  envelopeVersion: RECORD_ENVELOPE_VERSION,
  kind,
  writtenAt: new Date().toISOString(),
  checksum: checksumOf(payload),
  recordComplete: true,
  payload,
});

/** Writes bytes durably: temp file -> flush -> atomic rename over the destination. */
export const atomicWriteFile = async (filePath: string, contents: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    // Flush kernel buffers before the rename, so a crash cannot leave a renamed-but-empty file.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const writeRecord = async <T>(
  filePath: string,
  kind: string,
  payload: T,
): Promise<RecordEnvelope<T>> => {
  const envelope = buildEnvelope(kind, payload);
  await atomicWriteFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
};

/**
 * Creates a record that must not already exist, using exclusive creation.
 *
 * `wx` is the primitive the whole idempotency design rests on: the OS guarantees exactly one of any
 * number of concurrent creators succeeds. Returns false when the file already existed, so callers can
 * distinguish "I claimed it" from "someone else already had it" without a read-then-write race.
 */
export const writeRecordExclusive = async <T>(
  filePath: string,
  kind: string,
  payload: T,
): Promise<{ created: boolean; envelope: RecordEnvelope<T> }> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const envelope = buildEnvelope(kind, payload);
  const contents = `${JSON.stringify(envelope, null, 2)}\n`;
  try {
    // Exclusive create is atomic; the durability flush follows on the handle we know we own.
    const handle = await open(filePath, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { created: true, envelope };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, envelope };
    throw error;
  }
};

export const readRecord = async <T>(filePath: string, kind: string): Promise<ReadOutcome<T>> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "MISSING" };
    return {
      status: "CORRUPT",
      detail: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "CORRUPT",
      detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const envelope = parsed as Partial<RecordEnvelope<T>>;
  if (envelope === null || typeof envelope !== "object") {
    return { status: "CORRUPT", detail: "record is not an object" };
  }
  if (envelope.recordComplete !== true) {
    return { status: "CORRUPT", detail: "record is missing its completion marker" };
  }
  if (envelope.kind !== kind) {
    return {
      status: "CORRUPT",
      detail: `record kind mismatch: expected ${kind}, found ${String(envelope.kind)}`,
    };
  }
  if (typeof envelope.checksum !== "string" || envelope.payload === undefined) {
    return { status: "CORRUPT", detail: "record is missing its checksum or payload" };
  }
  const actual = checksumOf(envelope.payload);
  if (actual !== envelope.checksum) {
    return {
      status: "CORRUPT",
      detail: `checksum mismatch: payload hashes to ${actual}, record claims ${envelope.checksum}`,
    };
  }
  return { status: "OK", record: envelope as RecordEnvelope<T> };
};

/** Convenience for callers that treat MISSING and CORRUPT differently but want the payload. */
export const readPayload = async <T>(filePath: string, kind: string): Promise<T | null> => {
  const outcome = await readRecord<T>(filePath, kind);
  return outcome.status === "OK" ? outcome.record.payload : null;
};

export const ensureDirectory = async (dirPath: string): Promise<void> => {
  await mkdir(dirPath, { recursive: true });
};

export { writeFile as unsafeWriteFileForTests };
