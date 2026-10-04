CREATE TABLE "org_ai_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"model" text NOT NULL,
	"enabled" boolean NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_ai_models_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "org_ai_models_org_model_key" UNIQUE("org_id","model"),
	CONSTRAINT "org_ai_models_model_format" CHECK ("org_ai_models"."model" ~ '^[a-z0-9][a-z0-9.-]*$'),
	CONSTRAINT "org_ai_models_primary_is_on" CHECK ("org_ai_models"."enabled" OR NOT "org_ai_models"."is_primary"),
	CONSTRAINT "org_ai_models_position_not_negative" CHECK ("org_ai_models"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "org_ai_models" ADD CONSTRAINT "org_ai_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_ai_models" ADD CONSTRAINT "org_ai_models_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_ai_models_one_primary" ON "org_ai_models" USING btree ("org_id") WHERE is_primary;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_role_known" CHECK ("extraction_runs"."role" IN ('primary', 'backup'));