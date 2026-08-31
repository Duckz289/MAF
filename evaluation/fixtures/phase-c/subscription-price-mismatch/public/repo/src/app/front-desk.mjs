import { enrolAtPrice, openClub } from "./desk-operations.mjs";
import { rosterReport } from "../roster/member-directory.mjs";
import { buildStatement } from "../statements/statement-builder.mjs";

// Front-desk console. Opens the club, takes two enrolments either side of a price change, and
// prints the roster and a statement.
export function runFrontDesk() {
  openClub();
  const lines = [];
  const early = enrolAtPrice("Ada", "standard", 34.99);
  lines.push(`Ada enrolled on standard at ${early.rateAtEnrolment}`);
  const later = enrolAtPrice("Bo", "standard", 39);
  lines.push(`after the price moved to 39, Bo enrolled at ${later.rateAtEnrolment}`);
  lines.push(`roster size: ${rosterReport().length}`);
  lines.push(`Ada's statement total: ${buildStatement(early).total}`);
  return lines;
}
