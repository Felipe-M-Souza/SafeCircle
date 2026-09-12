CREATE TYPE "public"."checkin_status" AS ENUM('ACTIVE', 'SAFE', 'CANCELLED', 'OVERDUE');--> statement-breakpoint
CREATE TABLE "safety_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"status" "checkin_status" DEFAULT 'ACTIVE' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safety_checkins" ADD CONSTRAINT "safety_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_checkins" ADD CONSTRAINT "safety_checkins_group_id_trusted_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trusted_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "safety_checkins_active_per_user_group_unique" ON "safety_checkins" USING btree ("user_id","group_id") WHERE "safety_checkins"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "safety_checkins_user_id_idx" ON "safety_checkins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "safety_checkins_group_id_idx" ON "safety_checkins" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "safety_checkins_status_due_at_idx" ON "safety_checkins" USING btree ("status","due_at");