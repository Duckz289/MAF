import { seedEvent, getEvent, bookSeat } from "../src/seat-inventory.mjs";

seedEvent("concert-1", 1);

const auditFn = async () => {
  await Promise.resolve();
};

const [a, b] = await Promise.all([
  bookSeat("concert-1", "alice", auditFn),
  bookSeat("concert-1", "bob", auditFn),
]);

console.log("alice booked:", a, "bob booked:", b);
console.log("remaining available:", getEvent("concert-1").available);
console.log("bookedBy:", getEvent("concert-1").bookedBy);
