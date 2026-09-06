# @fde/crypto

Application-layer field encryption. The database only ever holds ciphertext; a
`bytea` column round-trips through here at the repository layer.

## Key hierarchy

```
AWS KMS root
  └─ per-tenant CMK              (tenants.cmk_key_ref)         ── or a customer BYOK key
       └─ per-engagement DEK     (engagements.wrapped_dek)     ── 32-byte AES key, wrapped
            └─ field ciphertext  (facts.body, evidence.quote, …)
```

- **`KeyProvider`** — the only thing that talks to KMS. `KmsKeyProvider` (real) /
  `FakeKeyProvider` (in-memory, test-only). `generateDek` on engagement
  creation, `unwrapDek` once per request.
- **`EngagementCipher`** — field encrypt/decrypt over the AWS Encryption SDK
  (`RawAesKeyringNode` keyed by the DEK). Every value carries encryption context
  `{ tenantId, engagementId, column }`, **verified on decrypt** — a blob moved to
  another column, engagement, or tenant fails to open. It is not row-bound:
  swapping two ciphertexts within one engagement+column is out of scope here.
- **`createEngagementCipher(provider, params)`** — unwraps the DEK once, returns a
  request-scoped cipher. Never cache it across requests.
- **`runWithCrypto` / `getCipher`** — `AsyncLocalStorage` context, set once per
  request (NestJS interceptor) or per Temporal activity.
- **`encryptRow` / `decryptRow`** — map the `EncryptedColumnSpec[]` for a table
  (see `@fde/db` `CRYPTO_COLUMNS`).

## Crypto-shred

The DEK exists only wrapped (in `engagements.wrapped_dek`) and, transiently,
unwrapped in one request's memory. `shredEngagement` (in `@fde/db`) clears the
wrapped blob and flips status to `shredded`; KMS cannot reconstruct it. With no
cross-request DEK cache, the effect is immediate. Async purge of the now-dead
ciphertext rows is a later Temporal workflow.

## Decisions (see the plan's "Resolved" section)

AWS Encryption SDK (not roll-our-own) · request-scoped DEK cache only · AAD =
tenant + engagement + column path · BYOK via cross-account KMS grant.

## Tests

`pnpm test` runs the unit suite (FakeKeyProvider, no AWS). The KMS integration
test is skipped unless `TEST_KMS_ENDPOINT` is set:

```bash
docker compose --profile aws up -d localstack
TEST_KMS_ENDPOINT=http://localhost:4566 pnpm test
```
