import { enrolMember } from "../enrolment/enrol-member.mjs";
import { setRate } from "../pricing/price-book.mjs";
import { registerMember } from "../roster/member-directory.mjs";
import { listPlans } from "../plans/plan-catalog.mjs";

// Operations the desk performs. A price change is recorded in the club's price book, and an
// enrolment is taken immediately afterwards.
export function openClub() {
  for (const plan of listPlans()) setRate(plan.id, plan.openingRate);
}

export function enrolAtPrice(memberName, planId, amount) {
  setRate(planId, amount);
  return enrolMember(registerMember(memberName), planId);
}
