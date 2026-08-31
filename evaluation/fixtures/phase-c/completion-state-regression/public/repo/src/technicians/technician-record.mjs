import { requireText } from "../util/guards.mjs";

export function makeTechnician(id, name) {
  requireText(name, "name");
  return { id, name };
}
