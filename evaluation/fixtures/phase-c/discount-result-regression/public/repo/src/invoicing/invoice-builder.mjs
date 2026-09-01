import { invoiceLinesFor } from "./invoice-lines.mjs";
import { sumMoney } from "../pricing/money.mjs";

export function draftInvoice(account, lane) {
  const lines = invoiceLinesFor(lane);
  return { account: account.id, lines, total: sumMoney(lines.map((line) => line.amount)) };
}
