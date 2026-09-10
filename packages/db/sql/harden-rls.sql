-- Run after EVERY migration. Idempotent.
--   1. FORCE row-level security  (so the table owner is bound by policies too)
--   2. grant the app role what each table needs
--   3. keep access_log append-only for the app role
--
-- The table list mirrors TENANT_SCOPED_TABLES in src/schema/tables.ts — keep both
-- in sync when adding a tenant-scoped table.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'users','engagements','sources','capture_sessions','connector_sync_state',
    'acl_snapshots','entities','relationships','facts','evidence','extraction_runs',
    'embeddings','identities','identity_review_queue','access_log','break_glass_grants'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_rw', t);
  end loop;

  -- tenants has no tenant_id column: it carries its own `tenants_self_isolation`
  -- policy (from the migration, scoped by primary key). Here we only ENABLE/FORCE
  -- RLS and lock it to read-only for the app role — provisioning runs out of band
  -- on a privileged (BYPASSRLS) connection.
  execute 'alter table tenants enable row level security';
  execute 'alter table tenants force row level security';
  execute 'grant select on tenants to app_rw';
  execute 'revoke insert, update, delete on tenants from app_rw';

  -- access_log is append-only for the app role.
  execute 'revoke update, delete on access_log from app_rw';
end
$$;
