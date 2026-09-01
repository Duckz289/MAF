import { buildCharge } from "../pricing/charge-builder.mjs";
import { validateQuoteRequest } from "./quote-request.mjs";
import { laneBaseRate } from "./rate-card.mjs";
import { requireAccount } from "../customers/account-directory.mjs";

// Public quoting entry point. Validates the request, then hands the priced charge back.
export function quoteShipment(basePrice, adjustment, taxRate) {
  validateQuoteRequest(basePrice, adjustment, taxRate);
  return buildCharge(basePrice, adjustment, taxRate).total;
}

export function quoteLaneForAccount(account, laneId, adjustment, taxRate) {
  requireAccount(account);
  return quoteShipment(laneBaseRate(laneId), adjustment, taxRate);
}
