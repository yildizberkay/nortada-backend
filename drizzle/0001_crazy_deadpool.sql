CREATE TYPE "public"."activity_condition_kind" AS ENUM('forecast', 'observed');--> statement-breakpoint
CREATE TYPE "public"."activity_privacy" AS ENUM('private', 'followers', 'public');--> statement-breakpoint
CREATE TYPE "public"."activity_source" AS ENUM('iphone', 'watch', 'import', 'manual');--> statement-breakpoint
CREATE TYPE "public"."activity_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."effort_type" AS ENUM('time_2s', 'time_5s', 'time_10s', 'time_20s', 'time_30s', 'time_1m', 'time_5m', 'dist_100m', 'dist_250m', 'dist_500m', 'dist_1km', 'dist_nm', 'best_5x10');--> statement-breakpoint
CREATE TYPE "public"."equipment_type" AS ENUM('board', 'sail', 'wing', 'kite', 'foil', 'boat', 'sup', 'kayak', 'paddle', 'generic');--> statement-breakpoint
CREATE TABLE "activity_condition" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_condition_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"kind" "activity_condition_kind" NOT NULL,
	"provider" text,
	"wind_speed_ms" real,
	"wind_gusts_ms" real,
	"wind_direction_deg" real,
	"temperature_c" real,
	"weather_code" integer,
	"captured_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_condition_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "activity_effort" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_effort_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"type" "effort_type" NOT NULL,
	"result_ms" real NOT NULL,
	"duration_sec" real,
	"distance_m" real,
	"start_offset_sec" real,
	"algorithm_version" integer NOT NULL,
	"computed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "activity_effort_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "activity_equipment" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_equipment_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"equipment_profile_id" integer NOT NULL,
	"role" text,
	"snapshot" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_equipment_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "activity_route" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_route_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"polyline" text NOT NULL,
	"algorithm_version" integer NOT NULL,
	"computed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "activity_route_uid_unique" UNIQUE("uid"),
	CONSTRAINT "activity_route_activity_id_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "activity_summary" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_summary_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"total_distance_m" real NOT NULL,
	"max_speed_ms" real NOT NULL,
	"avg_speed_ms" real NOT NULL,
	"avg_moving_speed_ms" real NOT NULL,
	"duration_sec" real NOT NULL,
	"moving_duration_sec" real NOT NULL,
	"max_distance_from_start_m" real,
	"valid_sample_count" integer NOT NULL,
	"gap_count" integer DEFAULT 0 NOT NULL,
	"algorithm_version" integer NOT NULL,
	"input_data_version" integer NOT NULL,
	"computed_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "activity_summary_uid_unique" UNIQUE("uid"),
	CONSTRAINT "activity_summary_activity_id_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"sport" "sport" NOT NULL,
	"custom_name" text,
	"status" "activity_status" DEFAULT 'processing' NOT NULL,
	"source" "activity_source" DEFAULT 'iphone' NOT NULL,
	"data_version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"timezone" text,
	"spot_uid" text,
	"spot_name" text,
	"start_lat" double precision,
	"start_lon" double precision,
	"end_lat" double precision,
	"end_lon" double precision,
	"device" text,
	"device_model" text,
	"os_version" text,
	"app_version" text,
	"notes" text,
	"feeling" text,
	"tags" text[],
	"perceived_effort" integer,
	"privacy" "activity_privacy" DEFAULT 'private' NOT NULL,
	"hide_start" boolean DEFAULT false NOT NULL,
	"hidden_radius_m" real,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "activity_track" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_track_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" integer NOT NULL,
	"sample_count" integer NOT NULL,
	"samples" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_track_uid_unique" UNIQUE("uid"),
	CONSTRAINT "activity_track_activity_id_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "equipment_profile" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equipment_profile_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"type" "equipment_type" NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_profile_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "activity_condition" ADD CONSTRAINT "activity_condition_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_effort" ADD CONSTRAINT "activity_effort_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_equipment" ADD CONSTRAINT "activity_equipment_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_equipment" ADD CONSTRAINT "activity_equipment_equipment_profile_id_equipment_profile_id_fk" FOREIGN KEY ("equipment_profile_id") REFERENCES "public"."equipment_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_route" ADD CONSTRAINT "activity_route_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_summary" ADD CONSTRAINT "activity_summary_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_track" ADD CONSTRAINT "activity_track_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_profile" ADD CONSTRAINT "equipment_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_condition_activity_kind_key" ON "activity_condition" USING btree ("activity_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_effort_activity_type_key" ON "activity_effort" USING btree ("activity_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_equipment_activity_profile_key" ON "activity_equipment" USING btree ("activity_id","equipment_profile_id");--> statement-breakpoint
CREATE INDEX "activity_user_started_idx" ON "activity" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "activity_user_sport_idx" ON "activity" USING btree ("user_id","sport");