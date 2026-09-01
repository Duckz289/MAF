export function migrateRecordV1toV2(v1) {
  const hadSchemaVersion = Object.hasOwn(v1, "schemaVersion");
  const previous = v1.schemaVersion;
  v1.schemaVersion = 2;
  const migrated = { ...v1 };
  if (hadSchemaVersion) v1.schemaVersion = previous;
  else delete v1.schemaVersion;
  return migrated;
}
