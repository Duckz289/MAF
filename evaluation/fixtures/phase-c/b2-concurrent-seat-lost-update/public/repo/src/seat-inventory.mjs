const events = new Map();

export function seedEvent(id, available) {
  events.set(id, { id, available, bookedBy: [] });
}

export function getEvent(id) {
  return events.get(id) ?? null;
}

export async function bookSeat(eventId, userId, auditFn = async () => {}) {
  const event = events.get(eventId);
  if (!event || event.available <= 0) return false;
  const remaining = event.available - 1;
  await auditFn({ eventId, userId });
  event.available = remaining;
  event.bookedBy.push(userId);
  return true;
}
