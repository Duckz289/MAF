export function migrateRecordV1toV2(v1) {
  const tags = v1.metadata && Array.isArray(v1.metadata.tags) ? v1.metadata.tags : null;
  if (tags) tags.push("__migrating");
  const migrated = { ...v1, schemaVersion: 2 };
  if (tags) tags.pop();
  return migrated;
}
