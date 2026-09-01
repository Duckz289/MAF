import { makeMember } from "./member-record.mjs";
import { nextId } from "../util/ids.mjs";

const members = new Map();

export function registerMember(name) {
  const member = makeMember(nextId("member"), name);
  members.set(member.id, member);
  return member;
}

export function rosterReport() {
  return [...members.values()].map((member) => ({ id: member.id, name: member.name }));
}
