/**
 * The SpiceDB schema the platform runs on. This string is authoritative — it is
 * what `schema:push` / `writeSchema` sends to SpiceDB. `schema.zed` at the
 * package root is a byte-identical copy kept for tooling (`zed validate`,
 * editor plugins); `schema.test.ts` asserts they match.
 *
 * Bump `SCHEMA_VERSION` on every change. SpiceDB has no schema-migration story
 * of its own — a change is applied by pushing the new full schema; removing a
 * relation/permission requires the relationships that reference it to be gone
 * first. Keep changes additive where possible.
 *
 * Scope (ROADMAP #10): platform roles only. The `engagement` definition carries
 * a marked spot where M5 adds a `source_acl` relation + `slack_channel` / doc
 * source definitions for per-source ACL mirroring — additive to what's here.
 */
export const SCHEMA_VERSION = '2026-09-08.1';

export const AUTHZ_SCHEMA = `
definition user {}

definition tenant {
	relation admin: user
	relation member: user
	permission administer = admin
}

definition engagement {
	relation parent_tenant: tenant
	relation admin: user
	relation member: user
	relation viewer: user

	// M5: + source_acl relation here; view gains "+ source_acl->access".
	permission view = viewer + member + admin + parent_tenant->administer
	permission contribute = member + admin
	permission administer = admin
}
`.trim();

/** Engagement platform roles, most-privileged last. */
export const ENGAGEMENT_ROLES = ['viewer', 'member', 'admin'] as const;
export type EngagementRole = (typeof ENGAGEMENT_ROLES)[number];

/** Tenant platform roles. */
export const TENANT_ROLES = ['member', 'admin'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
