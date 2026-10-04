CREATE TYPE "public"."route_provider" AS ENUM('openrouteservice');--> statement-breakpoint
CREATE TYPE "public"."route_status" AS ENUM('measuring', 'measured', 'failed');--> statement-breakpoint
CREATE TABLE "mileage_route_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"longitude" numeric(9, 6),
	"latitude" numeric(8, 6),
	"leg_metres" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_route_stops_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "mileage_route_stops_position_key" UNIQUE("org_id","expense_id","position"),
	CONSTRAINT "mileage_route_stops_position_range" CHECK ("mileage_route_stops"."position" BETWEEN 0 AND 24),
	CONSTRAINT "mileage_route_stops_address_length" CHECK (length("mileage_route_stops"."address") BETWEEN 1 AND 200),
	CONSTRAINT "mileage_route_stops_place_whole" CHECK (("mileage_route_stops"."label" IS NULL) = ("mileage_route_stops"."longitude" IS NULL) AND ("mileage_route_stops"."label" IS NULL) = ("mileage_route_stops"."latitude" IS NULL)),
	CONSTRAINT "mileage_route_stops_coordinates_range" CHECK ("mileage_route_stops"."longitude" BETWEEN -180 AND 180 AND "mileage_route_stops"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "mileage_route_stops_leg" CHECK ("mileage_route_stops"."leg_metres" >= 0 AND ("mileage_route_stops"."position" > 0 OR "mileage_route_stops"."leg_metres" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "mileage_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"round_trip" boolean DEFAULT false NOT NULL,
	"status" "route_status" NOT NULL,
	"request_id" uuid NOT NULL,
	"problem" text,
	"provider" "route_provider",
	"profile" text,
	"measured_at" timestamp with time zone,
	"distance_metres" integer,
	"return_metres" integer,
	"measured_miles" numeric(10, 2),
	"miles_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_routes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "mileage_routes_expense_key" UNIQUE("org_id","expense_id"),
	CONSTRAINT "mileage_routes_measured_whole" CHECK (("mileage_routes"."status" = 'measured') = ("mileage_routes"."provider" IS NOT NULL AND "mileage_routes"."profile" IS NOT NULL AND "mileage_routes"."measured_at" IS NOT NULL AND "mileage_routes"."distance_metres" IS NOT NULL AND "mileage_routes"."measured_miles" IS NOT NULL)),
	CONSTRAINT "mileage_routes_problem_when_failed" CHECK (("mileage_routes"."status" = 'failed') = ("mileage_routes"."problem" IS NOT NULL)),
	CONSTRAINT "mileage_routes_distance_nonnegative" CHECK ("mileage_routes"."distance_metres" >= 0 AND "mileage_routes"."return_metres" >= 0 AND "mileage_routes"."measured_miles" >= 0),
	CONSTRAINT "mileage_routes_reason_length" CHECK ("mileage_routes"."miles_reason" IS NULL OR length("mileage_routes"."miles_reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "route_service_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "route_provider" NOT NULL,
	"ciphertext" text NOT NULL,
	"key_hint" text NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_service_keys_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "route_service_keys_org_provider_key" UNIQUE("org_id","provider"),
	CONSTRAINT "route_service_keys_hint_short" CHECK (length("route_service_keys"."key_hint") <= 4)
);
--> statement-breakpoint
CREATE TABLE "saved_places" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_places_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "saved_places_name_length" CHECK (length("saved_places"."name") BETWEEN 1 AND 40),
	CONSTRAINT "saved_places_address_length" CHECK (length("saved_places"."address") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "mileage_route_stops" ADD CONSTRAINT "mileage_route_stops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_route_stops" ADD CONSTRAINT "mileage_route_stops_route_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."mileage_routes"("org_id","expense_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_routes" ADD CONSTRAINT "mileage_routes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_routes" ADD CONSTRAINT "mileage_routes_log_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."mileage_logs"("org_id","expense_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_service_keys" ADD CONSTRAINT "route_service_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_service_keys" ADD CONSTRAINT "route_service_keys_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_places_member_name_key" ON "saved_places" USING btree ("org_id","member_id",lower("name"));