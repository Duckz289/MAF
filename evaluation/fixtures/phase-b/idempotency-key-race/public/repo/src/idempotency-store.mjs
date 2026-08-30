export { markRecorded } from "./audit-log.mjs";

const reserved = new Set();

export function reserveKey(key) {
  if (reserved.has(key)) {
    return false;
  }
  reserved.add(key);
  return true;
}

export function releaseKey(key) {
  reserved.delete(key);
}
