const load = new Map();

export function addTechnicianLoad(technicianId) {
  load.set(technicianId, (load.get(technicianId) ?? 0) + 1);
}

export function technicianLoad() {
  return [...load.entries()].map(([technicianId, orders]) => ({ technicianId, orders }));
}
