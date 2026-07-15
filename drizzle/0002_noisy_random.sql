CREATE TYPE "public"."place_type" AS ENUM('public_spot', 'school', 'rental', 'club', 'center', 'marina', 'accommodation', 'shop');--> statement-breakpoint
ALTER TABLE "watersport_spot" ADD COLUMN "on_water" boolean;--> statement-breakpoint
ALTER TABLE "watersport_spot" ADD COLUMN "place_types" "place_type"[];