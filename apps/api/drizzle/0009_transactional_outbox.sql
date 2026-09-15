CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'DEAD');--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid,
	"group_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"processed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_error_code" text,
	"expires_at" timestamp with time zone,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "source_outbox_event_id" uuid;--> statement-breakpoint
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_events_lease_idx" ON "outbox_events" USING btree ("status","locked_at");--> statement-breakpoint
CREATE INDEX "outbox_events_status_created_idx" ON "outbox_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_event_type_idx" ON "outbox_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "outbox_events_processed_at_idx" ON "outbox_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "outbox_events_dead_lettered_at_idx" ON "outbox_events" USING btree ("dead_lettered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_source_outbox_event_unique" ON "audit_events" USING btree ("source_outbox_event_id");