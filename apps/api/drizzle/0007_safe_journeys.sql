CREATE TYPE "public"."journey_status" AS ENUM('ACTIVE', 'ARRIVED', 'CANCELLED', 'OVERDUE');--> statement-breakpoint
CREATE TABLE "journey_location_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "live_location_session_status" DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_location_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
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
CREATE TABLE "safe_journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"status" "journey_status" DEFAULT 'ACTIVE' NOT NULL,
	"destination_label" text,
	"expected_arrival_at" timestamp with time zone NOT NULL,
	"live_location_enabled" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"arrived_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journey_location_sessions" ADD CONSTRAINT "journey_location_sessions_journey_id_safe_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."safe_journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_location_sessions" ADD CONSTRAINT "journey_location_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_location_updates" ADD CONSTRAINT "journey_location_updates_session_id_journey_location_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."journey_location_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_location_updates" ADD CONSTRAINT "journey_location_updates_journey_id_safe_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."safe_journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_journeys" ADD CONSTRAINT "safe_journeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_journeys" ADD CONSTRAINT "safe_journeys_group_id_trusted_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trusted_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_location_sessions_active_per_journey_unique" ON "journey_location_sessions" USING btree ("journey_id") WHERE "journey_location_sessions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "journey_location_sessions_journey_id_idx" ON "journey_location_sessions" USING btree ("journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_location_updates_session_client_unique" ON "journey_location_updates" USING btree ("session_id","client_update_id");--> statement-breakpoint
CREATE INDEX "journey_location_updates_session_created_idx" ON "journey_location_updates" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "journey_location_updates_journey_id_idx" ON "journey_location_updates" USING btree ("journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_journeys_unfinished_per_user_unique" ON "safe_journeys" USING btree ("user_id") WHERE "safe_journeys"."status" in ('ACTIVE', 'OVERDUE');--> statement-breakpoint
CREATE INDEX "safe_journeys_user_id_idx" ON "safe_journeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "safe_journeys_group_id_idx" ON "safe_journeys" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "safe_journeys_status_expected_idx" ON "safe_journeys" USING btree ("status","expected_arrival_at");