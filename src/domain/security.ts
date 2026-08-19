const secretKey = /(api[-_]?key|secret|token|authorization|password|credential)/iu;
const secretValue =
  /(Bearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,})/giu;

export const redactSensitiveData = (value: unknown, key = ""): unknown => {
  const safeMetadataKey = /(reference|references|capability)$/iu.test(key);
  if (
    secretKey.test(key) &&
    !safeMetadataKey &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    return "[REDACTED]";
  if (typeof value === "string") return value.replace(secretValue, "[REDACTED]");
  if (Array.isArray(value)) return value.map((child) => redactSensitiveData(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSensitiveData(child, childKey),
      ]),
    );
  }
  return value;
};
