import { openMembership } from "./enrolment-service.mjs";
import { requireText } from "../util/guards.mjs";

// Command layer. Turns a desk request into an enrolment.
export function enrolMember(member, planId) {
  requireText(planId, "planId");
  return openMembership(member, planId);
}
