import { getCache, setCache } from "./ttl-cache.mjs";
import { userProfileCacheKey } from "./cache-keys.mjs";

const profiles = new Map([
  [1, { id: 1, email: "alice@example.com", name: "Alice" }],
  [2, { id: 2, email: "bob@example.com", name: "Bob" }],
]);

export function getUserProfile(userId) {
  const key = userProfileCacheKey(userId);
  const cached = getCache(key);
  if (cached) return { ...cached };
  const profile = profiles.get(userId);
  if (!profile) return null;
  setCache(key, { ...profile }, 60_000);
  return { ...profile };
}

export function updateUserProfile(userId, patch) {
  const profile = profiles.get(userId);
  if (!profile) throw new Error("profile not found");
  const updated = { ...profile, ...patch, id: userId };
  profiles.set(userId, updated);
  // Writes the fresh value straight through to the cache instead of invalidating it -- a
  // structurally different, still-correct architecture, keyed on the userId argument throughout.
  setCache(userProfileCacheKey(userId), { ...updated }, 60_000);
  return { ...updated };
}
