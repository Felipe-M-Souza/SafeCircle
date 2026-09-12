CREATE TYPE "public"."live_location_session_status" AS ENUM('ACTIVE', 'STOPPED');--> statement-breakpoint
CREATE TABLE "alert_location_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "live_location_session_status" DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_location_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"client_update_id" uuid NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy" double precision,
	"altitude" double precision,
	"heading" double precision,
	"speed" double precision,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_location_sessions" ADD CONSTRAINT "alert_location_sessions_alert_id_emergency_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."emergency_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_location_sessions" ADD CONSTRAINT "alert_location_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_location_updates" ADD CONSTRAINT "alert_location_updates_session_id_alert_location_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."alert_location_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_location_updates" ADD CONSTRAINT "alert_location_updates_alert_id_emergency_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."emergency_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_location_sessions_active_per_alert_unique" ON "alert_location_sessions" USING btree ("alert_id") WHERE "alert_location_sessions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "alert_location_sessions_alert_id_idx" ON "alert_location_sessions" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_location_updates_session_client_unique" ON "alert_location_updates" USING btree ("session_id","client_update_id");--> statement-breakpoint
CREATE INDEX "alert_location_updates_session_created_idx" ON "alert_location_updates" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_location_updates_alert_id_idx" ON "alert_location_updates" USING btree ("alert_id");