export function migrateRecordV1toV2(v1) {
  return Object.fromEntries([...Object.entries(v1), ["schemaVersion", 2]]);
}
