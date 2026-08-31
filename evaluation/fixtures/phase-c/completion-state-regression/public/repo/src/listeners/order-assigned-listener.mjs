import { addTechnicianLoad } from "../projections/technician-load.mjs";

export function onOrderAssigned(payload) {
  addTechnicianLoad(payload.technicianId);
}
