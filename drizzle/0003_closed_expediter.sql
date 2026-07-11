CREATE TYPE "public"."weather_kind" AS ENUM('forecast', 'marine');--> statement-breakpoint
CREATE TABLE "weather_cache" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weather_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"spot_uid" text NOT NULL,
	"kind" "weather_kind" NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	"model_run" timestamp (3) with time zone,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_cache_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "weather_model_meta" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weather_model_meta_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"last_run_availability_time" timestamp (3) with time zone,
	"update_interval_sec" integer,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_model_meta_uid_unique" UNIQUE("uid"),
	CONSTRAINT "weather_model_meta_model_unique" UNIQUE("model")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "weather_cache_spot_kind_key" ON "weather_cache" USING btree ("spot_uid","kind");--> statement-breakpoint
CREATE INDEX "weather_cache_expires_at_idx" ON "weather_cache" USING btree ("expires_at");