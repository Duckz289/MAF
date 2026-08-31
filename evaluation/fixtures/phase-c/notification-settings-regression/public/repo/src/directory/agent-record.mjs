import { requireText } from "../util/guards.mjs";

export function makeAgent(id, name, email, channel) {
  requireText(name, "name");
  requireText(email, "email");
  return { id, name, email, channel };
}
