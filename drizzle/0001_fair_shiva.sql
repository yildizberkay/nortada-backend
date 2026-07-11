CREATE TABLE "refresh_token" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refresh_token_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_hash" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_token_uid_unique" UNIQUE("uid"),
	CONSTRAINT "refresh_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token" USING btree ("expires_at");