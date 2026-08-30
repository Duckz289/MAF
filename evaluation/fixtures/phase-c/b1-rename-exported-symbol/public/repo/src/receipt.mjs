import { formatDisplayId } from "./id-utils.mjs";

export function renderReceiptHeader(orderId) {
  return `Receipt for ${formatDisplayId(orderId)}`;
}
