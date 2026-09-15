CREATE TABLE "auth_refresh_token_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "auth_refresh_token_history" ADD CONSTRAINT "auth_refresh_token_history_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_refresh_token_history_token_hash_unique" ON "auth_refresh_token_history" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_refresh_token_history_session_id_idx" ON "auth_refresh_token_history" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "auth_refresh_token_history_expires_at_idx" ON "auth_refresh_token_history" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_revoked_expires_idx" ON "auth_sessions" USING btree ("user_id","revoked_at","expires_at");