const BANDS = [
  [0, "LIGHT"],
  [500, "STANDARD"],
  [1_000, "HEAVY"],
];

export function bandForWeight(weightKg) {
  let band = "LIGHT";
  for (const [floor, name] of BANDS) if (weightKg >= floor) band = name;
  return band;
}
