export function migrateRecordV1toV2(v1) {
  const tags = v1.metadata && Array.isArray(v1.metadata.tags) ? v1.metadata.tags : null;
  const first = tags ? tags[0] : undefined;
  if (tags && tags.length > 0) tags[0] = "__migrating";
  const migrated = { ...v1, schemaVersion: 2 };
  if (tags && tags.length > 0) tags[0] = first;
  return migrated;
}
