// Old flat lookup-table discount scheme, superseded by services/discount-service.mjs's
// kind-based (PERCENT/FLAT) model. Unused by any live command.
const LEGACY_CODES = { SAVE10: 10, SAVE20: 20 };

export function applyLegacyDiscount(basePrice, code) {
  const percent = LEGACY_CODES[code] ?? 0;
  return basePrice * (1 - percent / 100);
}
