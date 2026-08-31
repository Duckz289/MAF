import { requireText } from "../util/guards.mjs";

export function makeAccount(id, name, email) {
  requireText(name, "name");
  requireText(email, "email");
  return { id, name, email };
}
