const queued = [];

// Every entry is queued and the queue is drained before returning, so the caller always receives
// state that has been written.
export function durableWrite(entry, store) {
  queued.push({ entry, store });
  let written = entry;
  while (queued.length > 0) {
    const next = queued.shift();
    written = next.store.save(next.entry);
  }
  return written;
}
