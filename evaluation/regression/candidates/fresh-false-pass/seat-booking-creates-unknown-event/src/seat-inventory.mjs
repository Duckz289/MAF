const events = new Map();

export function seedEvent(id, available) {
  events.set(id, { id, available, bookedBy: [] });
}

export function getEvent(id) {
  return events.get(id) ?? null;
}

export async function bookSeat(eventId, userId, auditFn = async () => {}) {
  if (!events.has(eventId)) seedEvent(eventId, 1);
  const event = events.get(eventId);
  if (event.available <= 0) return false;
  event.available -= 1;
  event.bookedBy.push(userId);
  await auditFn({ eventId, userId });
  return true;
}
