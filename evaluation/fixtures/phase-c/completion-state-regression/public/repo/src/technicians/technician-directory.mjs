import { makeTechnician } from "./technician-record.mjs";
import { nextId } from "../util/ids.mjs";

const technicians = new Map();

export function registerTechnician(name) {
  const technician = makeTechnician(nextId("tech"), name);
  technicians.set(technician.id, technician);
  return technician;
}

export function technicianName(technicianId) {
  return technicians.get(technicianId)?.name ?? "unassigned";
}
