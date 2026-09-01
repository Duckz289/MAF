# Enforce tenant ownership in bulk archive

`bulkArchiveItems(tenantId, itemIds)` may archive only items whose stored `tenantId` exactly matches
the caller tenant. Return one result per requested ID in input order: `{ id, archived: true }` when
archived, otherwise `{ id, archived: false, reason: "NOT_FOUND" | "TENANT_MISMATCH" }`. A missing
or foreign item must not be mutated, and one rejected item must not prevent eligible items in the
same batch from being archived.
