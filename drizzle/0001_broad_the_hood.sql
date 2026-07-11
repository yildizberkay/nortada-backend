CREATE TYPE "public"."activity_period" AS ENUM('week', 'month', 'season', 'year', 'custom');--> statement-breakpoint
CREATE TYPE "public"."analytics_focus" AS ENUM('balanced', 'speed', 'endurance', 'technique', 'racing', 'custom');--> statement-breakpoint
CREATE TYPE "public"."distance_unit" AS ENUM('km', 'mi', 'nm');--> statement-breakpoint
CREATE TYPE "public"."experience_level" AS ENUM('beginner', 'intermediate', 'advanced', 'racing');--> statement-breakpoint
CREATE TYPE "public"."main_goal" AS ENUM('find_days', 'track_sessions', 'improve_speed', 'improve_technique', 'consistency', 'racing', 'explore');--> statement-breakpoint
CREATE TYPE "public"."sport" AS ENUM('windsurf', 'wingfoil', 'sailing', 'kitesurf', 'sup', 'kayak', 'other');--> statement-breakpoint
CREATE TYPE "public"."summary_metric" AS ENUM('distance', 'time_on_water', 'moving_time', 'max_speed', 'avg_speed', 'best_10s', 'best_5x10', 'avg_pace', 'best_vmg', 'sessions', 'active_days');--> statement-breakpoint
CREATE TYPE "public"."temperature_unit" AS ENUM('c', 'f');--> statement-breakpoint
CREATE TYPE "public"."wind_unit" AS ENUM('kt', 'ms', 'kmh', 'mph');--> statement-breakpoint
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
	"planing_threshold_mps" real,
	"foiling_threshold_mps" real,
	"prefs" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sport_profile_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sport_profile" ADD CONSTRAINT "user_sport_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sport_profile_user_sport_key" ON "user_sport_profile" USING btree ("user_id","sport");