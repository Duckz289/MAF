export async function recordRefund(orderId, amount) {
  if (amount <= 0) throw new Error("invalid refund amount");
  return { recorded: true, orderId, amount };
}
