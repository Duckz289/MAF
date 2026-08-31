export function padCode(code, length) {
  const str = String(code);
  if (str.length >= length) return str;
  return typeof code === "number" ? str.padStart(length, "0") : str.padEnd(length, "0");
}
