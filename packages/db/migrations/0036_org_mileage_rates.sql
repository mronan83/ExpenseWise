CREATE TABLE "org_mileage_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"per_mile" numeric(12, 4),
	"currency" char(3),
	"set_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_mileage_rates_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "org_mileage_rates_org_day_key" UNIQUE("org_id","effective_from"),
	CONSTRAINT "org_mileage_rates_currency_iso" CHECK ("org_mileage_rates"."currency" IS NULL OR "org_mileage_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "org_mileage_rates_rate_and_currency" CHECK (("org_mileage_rates"."per_mile" IS NULL) = ("org_mileage_rates"."currency" IS NULL)),
	CONSTRAINT "org_mileage_rates_rate_positive" CHECK ("org_mileage_rates"."per_mile" IS NULL OR "org_mileage_rates"."per_mile" > 0)
);
--> statement-breakpoint
ALTER TABLE "org_mileage_rates" ADD CONSTRAINT "org_mileage_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_mileage_rates" ADD CONSTRAINT "org_mileage_rates_set_by_fk" FOREIGN KEY ("org_id","set_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;