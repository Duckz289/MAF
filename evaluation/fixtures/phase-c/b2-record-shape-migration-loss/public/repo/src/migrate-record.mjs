export function migrateRecordV1toV2(v1) {
  return {
    id: v1.id,
    name: v1.name,
    createdAt: v1.createdAt,
    schemaVersion: 2,
  };
}
