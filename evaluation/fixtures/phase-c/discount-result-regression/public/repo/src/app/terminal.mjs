import { seedCatalog } from "./seed-catalog.mjs";
import { quoteShipment } from "../quoting/quote-service.mjs";
import { adjustmentForCode } from "../promotions/promo-codes.mjs";
import { buildManifest } from "../manifest/shipment-manifest.mjs";
import { draftInvoice } from "../invoicing/invoice-builder.mjs";

// Operator terminal. Prints a quote, a promo-code quote, a manifest and a draft invoice for one
// seeded lane.
export function runFreightTerminal() {
  const { lane, account } = seedCatalog();
  const lines = [];
  lines.push(`base rate for ${lane.id}: ${lane.baseRate}`);
  lines.push(`quote with 10% off and 8% tax: ${quoteShipment(lane.baseRate, { kind: "PERCENT", value: 10 }, 0.08)}`);
  lines.push(`quote with 20 off and 8% tax: ${quoteShipment(lane.baseRate, { kind: "FLAT", value: 20 }, 0.08)}`);
  lines.push(`quote with promo BULK20 and 8% tax: ${quoteShipment(lane.baseRate, adjustmentForCode("BULK20"), 0.08)}`);
  lines.push(`manifest weight band: ${buildManifest(lane).band}`);
  lines.push(`draft invoice lines: ${draftInvoice(account, lane).lines.length}`);
  return lines;
}
