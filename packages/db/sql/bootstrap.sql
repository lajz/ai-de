-- Run ONCE per database, before the first migration, on a superuser /
-- rds_superuser connection. Idempotent.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Least-privilege application role. Every tenant query runs as app_rw (via
-- `withTenant`, which issues `SET LOCAL ROLE app_rw`) so RLS is enforced — see
-- harden-rls.sql for FORCE RLS.
--
-- `LOGIN` so a deployed app can connect directly as app_rw (attach a password or
-- IAM auth out of band). `SET LOCAL ROLE app_rw` is then a no-op in prod and the
-- privilege-drop safety net in local dev, where you connect as a superuser.
-- A non-superuser session that is NOT app_rw and NOT a member of it will fail
-- `SET ROLE` — that is deliberate (fail closed); grant membership with
-- `GRANT app_rw TO <login_role>` if you split the roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw login;
  end if;
end
$$;

grant usage on schema public to app_rw;

-- No blanket table grant here on purpose: app_rw gets DML only on the tables
-- harden-rls.sql explicitly lists. A freshly migrated table the app role has
-- never been granted is therefore unreadable until it is hardened — fail closed,
-- so forgetting `db:harden` denies access rather than leaking an unpoliced table.
