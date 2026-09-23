/**
 * Internal API-key issuance (v1: this script only — no self-serve UI yet, see
 * the agentic Q&A design). Mints a service-account `users` row, grants it a
 * role, and stores the key hashed. Prints the raw key exactly once.
 *
 * Defaults to per-engagement grants (least privilege) — pass one or more
 * `--engagement-id` flags. Tenant-wide access is an explicit opt-in via
 * `--tenant-wide`, mutually exclusive with `--engagement-id`.
 *
 * Usage:
 *   tsx apps/api/scripts/issue-api-key.ts \
 *     --tenant-id <uuid> --label "acme co-pilot" \
 *     --engagement-id <uuid> [--engagement-id <uuid> ...] [--role viewer|member|admin]
 *
 *   tsx apps/api/scripts/issue-api-key.ts \
 *     --tenant-id <uuid> --label "acme tenant-wide" --tenant-wide [--role member|admin]
 */
import { randomUUID } from 'node:crypto';

import { createAuthzClientFromEnv } from '@fde/authz';
import type { TenantId, UserId } from '@fde/core';
import { apiKeys, createDbClient, users } from '@fde/db';

import { generateApiKey } from '../auth/api-key.service.js';

interface Args {
  tenantId: TenantId;
  label: string;
  engagementIds: string[];
  tenantWide: boolean;
  role?: string;
}

function parseArgs(argv: string[]): Args {
  const engagementIds: string[] = [];
  let tenantId: string | undefined;
  let label: string | undefined;
  let tenantWide = false;
  let role: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === '--tenant-id') tenantId = next();
    else if (flag === '--label') label = next();
    else if (flag === '--engagement-id') engagementIds.push(next()!);
    else if (flag === '--role') role = next();
    else if (flag === '--tenant-wide') tenantWide = true;
    else throw new Error(`unknown flag: ${flag}`);
  }

  if (!tenantId) throw new Error('--tenant-id is required');
  if (!label) throw new Error('--label is required');
  if (tenantWide && engagementIds.length > 0) {
    throw new Error('--tenant-wide and --engagement-id are mutually exclusive');
  }
  if (!tenantWide && engagementIds.length === 0) {
    throw new Error(
      'pass at least one --engagement-id, or --tenant-wide to opt into tenant-wide access',
    );
  }

  return { tenantId: tenantId as TenantId, label, engagementIds, tenantWide, role };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const role = args.role ?? (args.tenantWide ? 'member' : 'viewer');

  const { db, close } = createDbClient({ url: process.env.DATABASE_URL ?? '' });
  const authz = createAuthzClientFromEnv(process.env);

  try {
    const email = `api-key+${randomUUID()}@service-accounts.internal`;
    const [user] = await db
      .insert(users)
      .values({ tenantId: args.tenantId, email, name: `API key: ${args.label}`, status: 'active' })
      .returning({ id: users.id });
    const userId = user!.id as UserId;

    if (args.tenantWide) {
      await authz.grantTenantRole(userId, args.tenantId, role as never);
    } else {
      for (const engagementId of args.engagementIds) {
        await authz.linkEngagementToTenant(engagementId as never, args.tenantId);
        await authz.grantEngagementRole(userId, engagementId as never, role as never);
      }
    }

    const key = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: args.tenantId,
      userId,
      keyHash: key.hashHex,
      keyPrefix: key.prefix,
      label: args.label,
    });

    process.stdout.write(`\nAPI key issued — shown once, store it now:\n\n  ${key.raw}\n\n`);
    process.stdout.write(
      `tenant: ${args.tenantId}  user: ${userId}  scope: ${
        args.tenantWide
          ? `tenant-wide (${role})`
          : `${args.engagementIds.length} engagement(s) (${role})`
      }\n`,
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
