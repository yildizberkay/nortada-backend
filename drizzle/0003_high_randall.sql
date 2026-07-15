CREATE TABLE "weather_map_frame" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weather_map_frame_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uid" text DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"layer" text NOT NULL,
	"valid_time" timestamp (3) with time zone NOT NULL,
	"run_time" timestamp (3) with time zone NOT NULL,
	"object_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"west" double precision NOT NULL,
	"south" double precision NOT NULL,
	"east" double precision NOT NULL,
	"north" double precision NOT NULL,
	"scales" jsonb NOT NULL,
	"rendered_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_map_frame_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "weather_map_frame_model_layer_valid_idx" ON "weather_map_frame" USING btree ("model","layer","valid_time");