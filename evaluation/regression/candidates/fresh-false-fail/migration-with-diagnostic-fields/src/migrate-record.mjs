// The prompt allows additional non-destructive diagnostic fields, so this migration records how it
// ran alongside the preserved record.
export function migrateRecordV1toV2(v1) {
  const preserved = Object.fromEntries(Object.entries(v1));
  return {
    ...preserved,
    schemaVersion: 2,
    migratedFromVersion: Object.hasOwn(v1, "schemaVersion") ? v1.schemaVersion : 1,
    preservedFieldCount: Object.keys(preserved).length,
  };
}
