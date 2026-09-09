CREATE TYPE "public"."engagement_status" AS ENUM('active', 'closed', 'shredded');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('us', 'eu');--> statement-breakpoint
CREATE TYPE "public"."retention_policy" AS ENUM('reference-only', 'derived-ephemeral-raw', 'full-retention');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."acl_refresh_state" AS ENUM('fresh', 'stale', 'refreshing', 'error');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('transcript', 'message', 'doc', 'issue', 'comment');--> statement-breakpoint
CREATE TYPE "public"."capture_session_status" AS ENUM('scheduled', 'recording', 'capturing', 'captured', 'failed');--> statement-breakpoint
CREATE TYPE "public"."connector_sync_status" AS ENUM('idle', 'running', 'error');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('person', 'organization', 'work_item', 'document', 'meeting');--> statement-breakpoint
CREATE TYPE "public"."graph_node_kind" AS ENUM('entity', 'fact');--> statement-breakpoint
CREATE TYPE "public"."predicate" AS ENUM('owns', 'accountable_for', 'informed_of', 'implemented_by', 'blocks', 'supersedes', 'relates_to', 'member_of', 'stakeholder_in');--> statement-breakpoint
CREATE TYPE "public"."evidence_relation" AS ENUM('supports', 'contradicts');--> statement-breakpoint
CREATE TYPE "public"."fact_status" AS ENUM('open', 'resolved', 'superseded', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."fact_type" AS ENUM('decision', 'commitment', 'risk', 'question', 'action_item', 'status_change');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'break_glass');--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"end_customer_name" text NOT NULL,
	"region_pin" "region" NOT NULL,
	"retention_policy" "retention_policy" NOT NULL,
	"wrapped_dek" text,
	"byok_key_arn" text,
	"status" "engagement_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region_pin" "region" DEFAULT 'us' NOT NULL,
	"cmk_key_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"workos_user_id" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "acl_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_ref" text NOT NULL,
	"principal_rules" "bytea" NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"refresh_state" "acl_refresh_state" DEFAULT 'fresh' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acl_snapshots_engagement_id_uq" UNIQUE("engagement_id","id")
);
--> statement-breakpoint
ALTER TABLE "acl_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"url_permalink" text,
	"workspace_ref" text,
	"container_ref" text,
	"author_ref" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"raw_object_key" text,
	"raw_body" "bytea",
	"retention_policy" "retention_policy" NOT NULL,
	"acl_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_engagement_id_uq" UNIQUE("engagement_id","id")
);
--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "capture_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"bot_id" text,
	"meeting_url" text NOT NULL,
	"join_at" timestamp with time zone NOT NULL,
	"status" "capture_session_status" DEFAULT 'scheduled' NOT NULL,
	"source_id" uuid,
	"purge_raw_after" timestamp with time zone,
	"failure_reason" text,
	"retention_policy" "retention_policy" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_sessions_bot_id_uq" UNIQUE("bot_id")
);
--> statement-breakpoint
ALTER TABLE "capture_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connector_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"cursor" text,
	"last_run_at" timestamp with time zone,
	"status" "connector_sync_status" DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"type" "entity_type" NOT NULL,
	"display_name" text NOT NULL,
	"external_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" "bytea" NOT NULL,
	"body" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"from_kind" "graph_node_kind" NOT NULL,
	"from_id" uuid NOT NULL,
	"predicate" "predicate" NOT NULL,
	"to_kind" "graph_node_kind" NOT NULL,
	"to_id" uuid NOT NULL,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"quote" "bytea",
	"char_start" integer,
	"char_end" integer,
	"relation" "evidence_relation" DEFAULT 'supports' NOT NULL,
	"extraction_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_char_span_ck" CHECK ("evidence"."char_start" is null or "evidence"."char_end" is null or ("evidence"."char_start" >= 0 and "evidence"."char_end" > "evidence"."char_start"))
);
--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_source_ids" jsonb NOT NULL,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_runs_engagement_id_uq" UNIQUE("engagement_id","id")
);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"type" "fact_type" NOT NULL,
	"summary" text NOT NULL,
	"body" "bytea",
	"status" "fact_status" DEFAULT 'open' NOT NULL,
	"confidence" double precision,
	"occurred_at" timestamp with time zone,
	"extraction_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_engagement_id_uq" UNIQUE("engagement_id","id")
);
--> statement-breakpoint
ALTER TABLE "facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"chunk_ref" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"external_account_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connection_secret_ref" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"authz_decision" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"reason" text NOT NULL,
	"ttl_minutes" integer DEFAULT 60 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "break_glass_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_snapshots" ADD CONSTRAINT "acl_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_snapshots" ADD CONSTRAINT "acl_snapshots_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_acl_snapshot_fk" FOREIGN KEY ("engagement_id","acl_snapshot_id") REFERENCES "public"."acl_snapshots"("engagement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_source_fk" FOREIGN KEY ("engagement_id","source_id") REFERENCES "public"."sources"("engagement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_state" ADD CONSTRAINT "connector_sync_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_state" ADD CONSTRAINT "connector_sync_state_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_fk" FOREIGN KEY ("engagement_id","source_id") REFERENCES "public"."sources"("engagement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_fact_fk" FOREIGN KEY ("engagement_id","fact_id") REFERENCES "public"."facts"("engagement_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_fk" FOREIGN KEY ("engagement_id","source_id") REFERENCES "public"."sources"("engagement_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_extraction_run_fk" FOREIGN KEY ("engagement_id","extraction_run_id") REFERENCES "public"."extraction_runs"("engagement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_extraction_run_fk" FOREIGN KEY ("engagement_id","extraction_run_id") REFERENCES "public"."extraction_runs"("engagement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_source_fk" FOREIGN KEY ("engagement_id","source_id") REFERENCES "public"."sources"("engagement_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "engagements_tenant_customer_uq" ON "engagements" USING btree ("tenant_id","end_customer_name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uq" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_dedupe_uq" ON "sources" USING btree ("engagement_id","connector","external_id","content_hash");--> statement-breakpoint
CREATE INDEX "sources_engagement_occurred_idx" ON "sources" USING btree ("engagement_id","occurred_at");--> statement-breakpoint
CREATE INDEX "capture_sessions_engagement_idx" ON "capture_sessions" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_sync_state_engagement_connector_uq" ON "connector_sync_state" USING btree ("engagement_id","connector");--> statement-breakpoint
CREATE INDEX "entities_engagement_type_idx" ON "entities" USING btree ("engagement_id","type");--> statement-breakpoint
CREATE INDEX "relationships_from_idx" ON "relationships" USING btree ("from_kind","from_id","predicate");--> statement-breakpoint
CREATE INDEX "relationships_to_idx" ON "relationships" USING btree ("to_kind","to_id","predicate");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_edge_uq" ON "relationships" USING btree ("from_kind","from_id","predicate","to_kind","to_id");--> statement-breakpoint
CREATE INDEX "evidence_fact_idx" ON "evidence" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "evidence_source_idx" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "facts_engagement_type_idx" ON "facts" USING btree ("engagement_id","type");--> statement-breakpoint
CREATE INDEX "embeddings_source_idx" ON "embeddings" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "embeddings_hnsw_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "identities_user_connector_uq" ON "identities" USING btree ("user_id","connector","external_account_id");--> statement-breakpoint
CREATE INDEX "access_log_engagement_idx" ON "access_log" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "break_glass_grants_engagement_idx" ON "break_glass_grants" USING btree ("engagement_id");--> statement-breakpoint
CREATE POLICY "engagements_tenant_isolation" ON "engagements" AS PERMISSIVE FOR ALL TO "app_rw" USING ("engagements"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("engagements"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenants_self_isolation" ON "tenants" AS PERMISSIVE FOR ALL TO "app_rw" USING ("tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO "app_rw" USING ("users"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("users"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "acl_snapshots_tenant_isolation" ON "acl_snapshots" AS PERMISSIVE FOR ALL TO "app_rw" USING ("acl_snapshots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("acl_snapshots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sources_tenant_isolation" ON "sources" AS PERMISSIVE FOR ALL TO "app_rw" USING ("sources"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("sources"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "capture_sessions_tenant_isolation" ON "capture_sessions" AS PERMISSIVE FOR ALL TO "app_rw" USING ("capture_sessions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("capture_sessions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "connector_sync_state_tenant_isolation" ON "connector_sync_state" AS PERMISSIVE FOR ALL TO "app_rw" USING ("connector_sync_state"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("connector_sync_state"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "entities_tenant_isolation" ON "entities" AS PERMISSIVE FOR ALL TO "app_rw" USING ("entities"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("entities"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "relationships_tenant_isolation" ON "relationships" AS PERMISSIVE FOR ALL TO "app_rw" USING ("relationships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("relationships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "evidence_tenant_isolation" ON "evidence" AS PERMISSIVE FOR ALL TO "app_rw" USING ("evidence"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("evidence"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extraction_runs_tenant_isolation" ON "extraction_runs" AS PERMISSIVE FOR ALL TO "app_rw" USING ("extraction_runs"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("extraction_runs"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facts_tenant_isolation" ON "facts" AS PERMISSIVE FOR ALL TO "app_rw" USING ("facts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("facts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "embeddings_tenant_isolation" ON "embeddings" AS PERMISSIVE FOR ALL TO "app_rw" USING ("embeddings"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("embeddings"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "identities_tenant_isolation" ON "identities" AS PERMISSIVE FOR ALL TO "app_rw" USING ("identities"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("identities"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_log_tenant_isolation" ON "access_log" AS PERMISSIVE FOR ALL TO "app_rw" USING ("access_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("access_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_isolation" ON "break_glass_grants" AS PERMISSIVE FOR ALL TO "app_rw" USING ("break_glass_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("break_glass_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);