import { joiningFee } from "../access/entry-log.mjs";

export function statementLinesFor(membership) {
  return [
    { label: "first month", amount: membership.rateAtEnrolment },
    { label: "joining fee", amount: joiningFee() },
  ];
}
