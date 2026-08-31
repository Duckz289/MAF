import { requireText } from "../util/guards.mjs";

export function makeMember(id, name) {
  requireText(name, "name");
  return { id, name, joinedAt: id };
}
