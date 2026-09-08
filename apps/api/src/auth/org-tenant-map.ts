import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantId } from '@fde/core';

import type { Env } from '../config/env.js';

/**
 * Resolves a WorkOS organization id to a tenant id, from `WORKOS_ORG_TENANT_MAP`.
 * The one piece of tenant provisioning the API can't derive from the schema as
 * it stands (see the note on `WORKOS_ORG_TENANT_MAP` in `config/env.ts`).
 */
@Injectable()
export class OrgTenantMap {
  private readonly map: Record<string, string>;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.map = config.get('WORKOS_ORG_TENANT_MAP', { infer: true });
  }

  resolve(organizationId: string | null | undefined): TenantId | undefined {
    if (!organizationId) return undefined;
    const tenantId = this.map[organizationId];
    return tenantId ? (tenantId as TenantId) : undefined;
  }
}
