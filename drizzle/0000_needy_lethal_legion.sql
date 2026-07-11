CREATE TYPE "public"."activity_period" AS ENUM('week', 'month', 'season', 'year', 'custom');--> statement-breakpoint
CREATE TYPE "public"."analytics_focus" AS ENUM('balanced', 'speed', 'endurance', 'technique', 'racing', 'custom');--> statement-breakpoint
CREATE TYPE "public"."compass_direction" AS ENUM('N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW');--> statement-breakpoint
CREATE TYPE "public"."distance_unit" AS ENUM('km', 'mi', 'nm');--> statement-breakpoint
CREATE TYPE "public"."experience_level" AS ENUM('beginner', 'intermediate', 'advanced', 'racing');--> statement-breakpoint
CREATE TYPE "public"."main_goal" AS ENUM('find_days', 'track_sessions', 'improve_speed', 'improve_technique', 'consistency', 'racing', 'explore');--> statement-breakpoint
CREATE TYPE "public"."sport" AS ENUM('windsurf', 'wingfoil', 'sailing', 'kitesurf', 'sup', 'kayak', 'other');--> statement-breakpoint
CREATE TYPE "public"."spot_skill" AS ENUM('beginner', 'intermediate', 'advanced', 'all');--> statement-breakpoint
CREATE TYPE "public"."spot_source" AS ENUM('osm', 'curated', 'user_suggested');--> statement-breakpoint
CREATE TYPE "public"."spot_status" AS ENUM('published', 'pending', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."summary_metric" AS ENUM('distance', 'time_on_water', 'moving_time', 'max_speed', 'avg_speed', 'best_10s', 'best_5x10', 'avg_pace', 'best_vmg', 'sessions', 'active_days');--> statement-breakpoint
CREATE TYPE "public"."temperature_unit" AS ENUM('c', 'f');--> statement-breakpoint
CREATE TYPE "public"."water_type" AS ENUM('sea', 'lake', 'bay', 'river', 'marina', 'open_coast');--> statement-breakpoint
CREATE TYPE "public"."weather_kind" AS ENUM('forecast', 'marine');--> statement-breakpoint
CREATE TYPE "public"."wind_unit" AS ENUM('kt', 'ms', 'kmh', 'mph');--> statement-breakpoint
CREATE TABLE "user_favorite" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_favorite_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"spot_id" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "watersport_spot" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "watersport_spot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"region" text,
	"locality" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"water_type" "water_type",
	"supported_sports" "sport"[] NOT NULL,
	"skill_suitability" "spot_skill",
	"shore_bearing_deg" real,
	"good_wind_directions" "compass_direction"[],
	"risky_wind_directions" "compass_direction"[],
	"hazards" text[],
	"source" "spot_source" NOT NULL,
	"osm_id" text,
	"status" "spot_status" DEFAULT 'pending' NOT NULL,
	"created_by" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watersport_spot_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_profile_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"primary_sport" "sport" NOT NULL,
	"sports" "sport"[] NOT NULL,
	"experience" "experience_level" NOT NULL,
	"goal" "main_goal" NOT NULL,
	"focus" "analytics_focus" NOT NULL,
	"activity_filter" "sport",
	"card_slots" "summary_metric"[] NOT NULL,
	"default_activity_period" "activity_period" NOT NULL,
	"wind_unit" "wind_unit" NOT NULL,
	"distance_unit" "distance_unit" NOT NULL,
	"temperature_unit" "temperature_unit" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profile_uid_unique" UNIQUE("uid"),
	CONSTRAINT "user_profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_sport_profile" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_sport_profile_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"sport" "sport" NOT NULL,
	"card_slots" "summary_metric"[],
	"prefs" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sport_profile_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"anonymous_device_id" text,
	"email" text,
	"display_name" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"merged_into_user_id" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
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
ALTER TABLE "user_favorite" ADD CONSTRAINT "user_favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite" ADD CONSTRAINT "user_favorite_spot_id_watersport_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."watersport_spot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watersport_spot" ADD CONSTRAINT "watersport_spot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sport_profile" ADD CONSTRAINT "user_sport_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_merged_into_user_id_user_id_fk" FOREIGN KEY ("merged_into_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_favorite_user_spot_key" ON "user_favorite" USING btree ("user_id","spot_id");--> statement-breakpoint
CREATE INDEX "watersport_spot_lat_lon_idx" ON "watersport_spot" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "watersport_spot_status_idx" ON "watersport_spot" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "watersport_spot_osm_id_key" ON "watersport_spot" USING btree ("osm_id") WHERE "watersport_spot"."osm_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sport_profile_user_sport_key" ON "user_sport_profile" USING btree ("user_id","sport");--> statement-breakpoint
CREATE UNIQUE INDEX "user_clerk_user_id_key" ON "user" USING btree ("clerk_user_id") WHERE "user"."clerk_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_anonymous_device_id_key" ON "user" USING btree ("anonymous_device_id") WHERE "user"."anonymous_device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_merged_into_user_id_idx" ON "user" USING btree ("merged_into_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weather_cache_spot_kind_key" ON "weather_cache" USING btree ("spot_uid","kind");--> statement-breakpoint
CREATE INDEX "weather_cache_expires_at_idx" ON "weather_cache" USING btree ("expires_at");