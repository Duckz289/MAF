import { registerLane } from "../catalog/lane-catalog.mjs";
import { registerAccount } from "../customers/account-directory.mjs";

export function seedCatalog() {
  const lane = registerLane("Rotterdam", "Milan", 120, 850);
  const account = registerAccount("Northwind Freight", "billing@example.com");
  return { lane, account };
}
