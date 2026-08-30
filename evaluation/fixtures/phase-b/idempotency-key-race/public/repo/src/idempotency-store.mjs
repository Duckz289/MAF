import { hasRecord } from "./audit-log.mjs";
export { markRecorded } from "./audit-log.mjs";

const reserved = new Set();

export async function reserveKey(key) {
  if (reserved.has(key)) {
    return false;
  }
  if (await hasRecord(key)) return false;
  reserved.add(key);
  return true;
}

export function releaseKey(key) {
  reserved.delete(key);
}
