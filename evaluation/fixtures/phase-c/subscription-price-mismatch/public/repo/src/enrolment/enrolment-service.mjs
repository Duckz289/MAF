import { quoteRate } from "../pricing/rate-quote.mjs";
import { makeMembership } from "./membership-record.mjs";
import { membershipLedger } from "./membership-ledger.mjs";
import { requirePlan } from "../plans/plan-catalog.mjs";

// Opens a membership and captures what the member agreed to pay.
export function openMembership(member, planId) {
  requirePlan(planId);
  const membership = makeMembership(member.id, planId, quoteRate(planId));
  membershipLedger.save(membership);
  return membership;
}
