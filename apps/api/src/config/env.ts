import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The API's environment contract. `@nestjs/config` runs `validateEnv` at boot
 * (see `config.module.ts`) and the process refuses to start on a missing or
 * malformed value — no lazy "undefined at first use" failures.
 *
 * WorkOS credentials are optional in dev/test: with no `WORKOS_API_KEY` the
 * `WorkOsModule` binds the in-memory fake (`FakeWorkOsService`) and live WorkOS
 * calls are never made. In production they are required — the refinement at the
 * bottom enforces that.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().url(),

    WORKOS_API_KEY: z.string().optional(),
    WORKOS_CLIENT_ID: z.string().optional(),
    WORKOS_WEBHOOK_SECRET: z.string().optional(),
    WORKOS_REDIRECT_URI: z.string().url().optional(),

    /**
     * WorkOS organization id → tenant id. Directory-Sync and SSO events name a
     * WorkOS org; this is how the API resolves that to a `tenants` row without a
     * schema change. A real deployment moves this into tenant provisioning
     * (`tenants.workos_org_id`); kept as config here to keep PR #5 to `apps/api`.
     * JSON: `{"org_01H...":"<tenant-uuid>"}`.
     */
    WORKOS_ORG_TENANT_MAP: z
      .string()
      .default('{}')
      .transform((raw, ctx): Record<string, string> => {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Object.values(parsed).some((v) => typeof v !== 'string')
          ) {
            throw new Error('not a string→string object');
          }
          const map = parsed as Record<string, string>;
          const bad = Object.entries(map).filter(([, tenantId]) => !UUID.test(tenantId));
          if (bad.length) {
            throw new Error(
              `tenant ids must be UUIDs (bad: ${bad.map(([org]) => org).join(', ')})`,
            );
          }
          return map;
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `WORKOS_ORG_TENANT_MAP invalid: ${(err as Error).message}`,
          });
          return z.NEVER;
        }
      }),

    /** dev/test only — swaps `KmsKeyProvider` for the in-memory `FakeKeyProvider` */
    FDE_FAKE_KMS: z.enum(['true', 'false']).optional(),
    AWS_REGION: z.string().optional(),

    /**
     * SpiceDB (`@fde/authz`). Unset in dev/test → the in-memory `AuthzClient`
     * (`createAuthzClientFromEnv`). Required under `NODE_ENV=production` — the
     * in-memory client refuses to run there.
     */
    SPICEDB_ENDPOINT: z.string().optional(),
    SPICEDB_TOKEN: z.string().optional(),
    SPICEDB_INSECURE: z.enum(['true', 'false']).optional(),

    /**
     * When `true`, single-engagement reads additionally pass through
     * `canViewEngagement` (403 on failure) and `GET /engagements` filters its
     * RLS-scoped list through `listViewableEngagements` — layered on top of RLS,
     * never replacing it. Default `false`: RLS scoping is the only gate and
     * every pre-#10 test stays green.
     */
    AUTHZ_ENFORCE: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const key of ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_WEBHOOK_SECRET'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when NODE_ENV=production`,
          });
        }
      }
      if (env.FDE_FAKE_KMS === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FDE_FAKE_KMS'],
          message: 'FDE_FAKE_KMS=true is not allowed when NODE_ENV=production',
        });
      }
      for (const key of ['SPICEDB_ENDPOINT', 'SPICEDB_TOKEN'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when NODE_ENV=production (the in-memory AuthzClient is refused there)`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** `validate` hook for `ConfigModule.forRoot`. Throws (aborting boot) on any issue. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
