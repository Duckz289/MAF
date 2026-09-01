import { requireText } from "../util/guards.mjs";

export function makePicker(id, name) {
  requireText(name, "name");
  return { id, name };
}
