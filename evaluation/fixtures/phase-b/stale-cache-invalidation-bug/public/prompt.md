# Invalidate user-profile cache entries after updates

Implement the missing `src/user-profile-service.mjs` API used by the demo. `getUserProfile(userId)`
returns the current profile and may cache it by `userProfileCacheKey(userId)`.
`updateUserProfile(userId, patch)` merges the patch into the stored profile and returns the updated
profile. A successful update must ensure every later read for that user observes the update while
leaving other users' cached profiles untouched. The contract does not require an exact number of
backing-store loads.
