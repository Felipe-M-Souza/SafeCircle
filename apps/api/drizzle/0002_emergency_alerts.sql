CREATE TYPE "public"."alert_status" AS ENUM('ACTIVE', 'RESOLVED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "alert_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy" double precision,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emergency_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"status" "alert_status" DEFAULT 'ACTIVE' NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_locations" ADD CONSTRAINT "alert_locations_alert_id_emergency_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."emergency_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_group_id_trusted_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trusted_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_locations_alert_id_idx" ON "alert_locations" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_alerts_active_per_user_group_unique" ON "emergency_alerts" USING btree ("created_by_user_id","group_id") WHERE "emergency_alerts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "emergency_alerts_group_id_status_idx" ON "emergency_alerts" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "emergency_alerts_created_by_user_id_idx" ON "emergency_alerts" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_user_scope_key_unique" ON "idempotency_keys" USING btree ("user_id","scope","key");