import { statementLinesFor } from "./statement-lines.mjs";
import { asAmount } from "../pricing/currency.mjs";

export function buildStatement(membership) {
  const lines = statementLinesFor(membership);
  return {
    memberId: membership.memberId,
    lines,
    total: asAmount(lines.reduce((sum, line) => sum + line.amount, 0)),
  };
}
