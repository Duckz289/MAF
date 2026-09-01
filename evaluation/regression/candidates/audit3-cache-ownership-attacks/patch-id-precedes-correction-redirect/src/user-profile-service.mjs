import { getCache, invalidateCache, setCache } from "./ttl-cache.mjs";
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
  // Invalidates against the merge's own id -- which still carries whatever `patch.id` supplied --
  // before the id is corrected back to the real target for storage. A different code shape than a
  // `??` fallback, but the same ownership-redirection bug: cache invalidation is decided by patch
  // content instead of by the userId argument.
  const merged = { ...profile, ...patch };
  invalidateCache(userProfileCacheKey(merged.id));
  merged.id = userId;
  profiles.set(userId, merged);
  return { ...merged };
}
