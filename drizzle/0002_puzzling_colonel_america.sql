CREATE TYPE "public"."compass_direction" AS ENUM('N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW');--> statement-breakpoint
CREATE TYPE "public"."spot_skill" AS ENUM('beginner', 'intermediate', 'advanced', 'all');--> statement-breakpoint
CREATE TYPE "public"."spot_source" AS ENUM('osm', 'curated', 'user_suggested');--> statement-breakpoint
CREATE TYPE "public"."spot_status" AS ENUM('published', 'pending', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."water_type" AS ENUM('sea', 'lake', 'bay', 'river', 'marina', 'open_coast');--> statement-breakpoint
CREATE TABLE "favorite" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "favorite_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"spot_id" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "spot" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
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
	CONSTRAINT "spot_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorite_user_spot_key" ON "favorite" USING btree ("user_id","spot_id");--> statement-breakpoint
CREATE INDEX "spot_lat_lon_idx" ON "spot" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "spot_status_idx" ON "spot" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "spot_osm_id_key" ON "spot" USING btree ("osm_id") WHERE "spot"."osm_id" IS NOT NULL;