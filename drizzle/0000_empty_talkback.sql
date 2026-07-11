CREATE TABLE "user" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"anonymous_device_id" text,
	"email" text,
	"display_name" text,
	"merged_into_user_id" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_merged_into_user_id_user_id_fk" FOREIGN KEY ("merged_into_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_clerk_user_id_key" ON "user" USING btree ("clerk_user_id") WHERE "user"."clerk_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_anonymous_device_id_key" ON "user" USING btree ("anonymous_device_id") WHERE "user"."anonymous_device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_merged_into_user_id_idx" ON "user" USING btree ("merged_into_user_id");