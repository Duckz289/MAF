import { lookupPromo } from "./promo-registry.mjs";
import { ADJUSTMENT_KINDS } from "../pricing/adjustment-kinds.mjs";

// Code-based promotions are a separate entry path with their own compatibility rules. They convert
// a code into an adjustment and leave the pricing itself to the quoting flow.
export function adjustmentForCode(code) {
  const promo = lookupPromo(code);
  if (!promo) return { kind: ADJUSTMENT_KINDS.FLAT, value: 0 };
  return { kind: promo.kind, value: promo.value };
}
