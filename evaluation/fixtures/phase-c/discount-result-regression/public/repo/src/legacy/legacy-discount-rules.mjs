// Promotion-code compatibility rules used by import and reporting integrations.
const LEGACY_CODES = { SAVE10: 10, SAVE20: 20 };

export function applyLegacyDiscount(basePrice, code) {
  const percent = LEGACY_CODES[code] ?? 0;
  return basePrice * (1 - percent / 100);
}
