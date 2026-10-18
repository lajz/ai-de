CREATE TABLE "custom_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mapping" jsonb NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_prefix" text NOT NULL,
	"secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ingested_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_integrations_secret_hash_uq" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_integrations_secret_prefix_idx" ON "custom_integrations" USING btree ("secret_prefix");--> statement-breakpoint
CREATE INDEX "custom_integrations_engagement_idx" ON "custom_integrations" USING btree ("tenant_id","engagement_id");