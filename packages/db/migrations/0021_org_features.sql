CREATE TABLE "org_features" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_features_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "org_features_org_flag_key" UNIQUE("org_id","flag"),
	CONSTRAINT "org_features_flag_format" CHECK ("org_features"."flag" ~ '^[a-z]+\.[a-z-]+$')
);
--> statement-breakpoint
ALTER TABLE "org_features" ADD CONSTRAINT "org_features_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_features" ADD CONSTRAINT "org_features_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;