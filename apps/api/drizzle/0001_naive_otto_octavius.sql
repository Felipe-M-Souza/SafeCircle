CREATE TYPE "public"."group_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "group_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"invited_email" text NOT NULL,
	"status" "invitation_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "group_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_group_id_trusted_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trusted_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_trusted_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trusted_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_invitations_group_email_pending_unique" ON "group_invitations" USING btree ("group_id","invited_email") WHERE "group_invitations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "group_invitations_group_id_idx" ON "group_invitations" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_invitations_invited_email_idx" ON "group_invitations" USING btree ("invited_email");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_group_user_unique" ON "group_memberships" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_single_owner_unique" ON "group_memberships" USING btree ("group_id") WHERE "group_memberships"."role" = 'OWNER';--> statement-breakpoint
CREATE INDEX "group_memberships_user_id_idx" ON "group_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_group_id_idx" ON "group_memberships" USING btree ("group_id");