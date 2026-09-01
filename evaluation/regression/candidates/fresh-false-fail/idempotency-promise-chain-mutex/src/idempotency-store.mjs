import { hasRecord } from "./audit-log.mjs";
export { markRecorded } from "./audit-log.mjs";

const reserved = new Set();
// One chain per key. Nothing global is held, so unrelated keys never wait on each other.
const chains = new Map();

const onKey = (key, work) => {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
};

export async function reserveKey(key) {
  return await onKey(key, async () => {
    if (reserved.has(key)) return false;
    if (await hasRecord(key)) return false;
    reserved.add(key);
    return true;
  });
}

export function releaseKey(key) {
  reserved.delete(key);
}
