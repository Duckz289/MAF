const events = new Map();

export function seedEvent(id, available) {
  events.set(id, {
    id,
    available,
    bookedBy: [],
    // A pool of concrete seat tokens. Taking one is a single synchronous array operation.
    tokens: Array.from({ length: available }, (_, index) => `seat-${index + 1}`),
  });
}

export function getEvent(id) {
  return events.get(id) ?? null;
}

export async function bookSeat(eventId, userId, auditFn = async () => {}) {
  const event = events.get(eventId);
  if (!event) return false;
  const token = event.tokens.shift();
  if (token === undefined) return false;
  event.available -= 1;
  event.bookedBy.push(userId);
  await auditFn({ eventId, userId, token });
  return true;
}
