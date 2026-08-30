# Preserve record fields during the V1-to-V2 migration

`migrateRecordV1toV2(v1)` must return a new record with `schemaVersion: 2` while preserving every
own enumerable field from the input, including fields unknown to the migration such as `metadata`.
It must not mutate the input. Additional non-destructive diagnostic fields are allowed; callers must
not be rejected merely because their record shape has extensions.
