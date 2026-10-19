CREATE TABLE "saved_route_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"longitude" numeric(9, 6),
	"latitude" numeric(8, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_route_stops_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "saved_route_stops_position_key" UNIQUE("org_id","route_id","position"),
	CONSTRAINT "saved_route_stops_position_range" CHECK ("saved_route_stops"."position" BETWEEN 0 AND 24),
	CONSTRAINT "saved_route_stops_address_length" CHECK (length("saved_route_stops"."address") BETWEEN 1 AND 200),
	CONSTRAINT "saved_route_stops_place_whole" CHECK (("saved_route_stops"."label" IS NULL) = ("saved_route_stops"."longitude" IS NULL) AND ("saved_route_stops"."label" IS NULL) = ("saved_route_stops"."latitude" IS NULL)),
	CONSTRAINT "saved_route_stops_coordinates_range" CHECK ("saved_route_stops"."longitude" BETWEEN -180 AND 180 AND "saved_route_stops"."latitude" BETWEEN -90 AND 90)
);
--> statement-breakpoint
CREATE TABLE "saved_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"round_trip" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_routes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "saved_routes_name_length" CHECK (length("saved_routes"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "saved_route_stops" ADD CONSTRAINT "saved_route_stops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_route_stops" ADD CONSTRAINT "saved_route_stops_route_fk" FOREIGN KEY ("org_id","route_id") REFERENCES "public"."saved_routes"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_route_stops" ADD CONSTRAINT "saved_route_stops_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_routes" ADD CONSTRAINT "saved_routes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_routes" ADD CONSTRAINT "saved_routes_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_routes_member_name_key" ON "saved_routes" USING btree ("org_id","member_id",lower("name"));