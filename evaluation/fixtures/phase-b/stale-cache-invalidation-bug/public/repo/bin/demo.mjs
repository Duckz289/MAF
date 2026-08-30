import { getUserProfile, updateUserProfile } from "../src/user-profile-service.mjs";

console.log(JSON.stringify(getUserProfile(1)));
updateUserProfile(1, { email: "alice+new@example.com" });
console.log(JSON.stringify(getUserProfile(1)));
