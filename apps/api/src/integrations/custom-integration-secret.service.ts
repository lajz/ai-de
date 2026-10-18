import { Injectable } from '@nestjs/common';

import { generateSecret, secretMatches, type GeneratedSecret } from '../auth/secret-hash.js';

const RAW_PREFIX = 'fdeci_';
/** Stored for admin-UI display only — never used for lookup. */
const PREFIX_LEN = 14;

/**
 * Mint + verify the per-integration ingest secret. Distinct `fdeci_` prefix
 * from `fde_` API keys, so a leaked secret's shape also says which kind it is.
 * No bucket scan (cf. `ApiKeyService.resolve`): the ingest URL already names
 * the exact row, so there is exactly one hash to compare against.
 */
@Injectable()
export class CustomIntegrationSecretService {
  generate(): GeneratedSecret {
    return generateSecret({ rawPrefix: RAW_PREFIX, prefixLen: PREFIX_LEN });
  }

  verify(raw: string, storedHashHex: string): boolean {
    return secretMatches(raw, storedHashHex);
  }
}
