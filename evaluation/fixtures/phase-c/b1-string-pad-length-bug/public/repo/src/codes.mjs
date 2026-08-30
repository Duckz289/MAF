export function padCode(code, length) {
  const str = String(code);
  if (str.length >= length) return str;
  return str.padEnd(length, "0");
}
