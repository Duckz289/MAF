import { hasRecord } from "./audit-log.mjs";
export { markRecorded } from "./audit-log.mjs";

const reserved = new Set();
let held = false;

export async function reserveKey(key) {
  if (held) return false;
  held = true;
  try {
    if (reserved.has(key)) return false;
    if (await hasRecord(key)) return false;
    reserved.add(key);
    return true;
  } finally {
    held = false;
  }
}

export function releaseKey(key) {
  reserved.delete(key);
}
