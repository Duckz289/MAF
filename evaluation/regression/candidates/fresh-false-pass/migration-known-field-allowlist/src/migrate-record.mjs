const CARRIED = ["id", "name", "createdAt", "metadata"];

export function migrateRecordV1toV2(v1) {
  const migrated = { schemaVersion: 2 };
  for (const key of CARRIED) {
    if (Object.hasOwn(v1, key)) migrated[key] = v1[key];
  }
  return migrated;
}
