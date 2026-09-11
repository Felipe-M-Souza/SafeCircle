CREATE TYPE "public"."acknowledgement_type" AS ENUM('SEEN', 'ACKNOWLEDGED', 'GOING_TO_HELP', 'EMERGENCY_SERVICES_CONTACTED');--> statement-breakpoint
CREATE TABLE "alert_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "acknowledgement_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_acknowledgements" ADD CONSTRAINT "alert_acknowledgements_alert_id_emergency_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."emergency_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_acknowledgements" ADD CONSTRAINT "alert_acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_acknowledgements_alert_user_unique" ON "alert_acknowledgements" USING btree ("alert_id","user_id");--> statement-breakpoint
CREATE INDEX "alert_acknowledgements_alert_id_idx" ON "alert_acknowledgements" USING btree ("alert_id");