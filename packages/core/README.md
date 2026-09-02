# @fde/core

The shared domain vocabulary. No I/O, no framework — just types, Zod schemas, and
small pure helpers that every other package and app depends on.

Contents:

- **ids / branded** — branded id types (`TenantId`, `EngagementId`, …), `Ciphertext`
- **region / retention / engagement** — enums + the retention-policy rules
  (`effectiveRetention`, `storesRawBody`, Slack forced to `reference-only`)
- **provenance** — `SourceKind`, `AclPrincipalRule`, `AclSnapshot`
- **entities / facts / relationships** — the canonical graph vocabulary
- **raw-artifact / canonical / sync** — the connector data contract
- **connector** — the `Connector` interface every integration implements

Enum _values_ live here as `as const` tuples (e.g. `FACT_TYPES`); `@fde/db` derives
its Postgres enums from the same tuples so the two never drift.
