CREATE TYPE "public"."conversion_outcome" AS ENUM('converted', 'unavailable');--> statement-breakpoint
CREATE TABLE "expense_conversions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"purchase_date" date NOT NULL,
	"reimbursement_currency" char(3) NOT NULL,
	"outcome" "conversion_outcome" NOT NULL,
	"converted_minor" bigint,
	"rate" numeric,
	"rate_date" date,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_conversions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_conversions_expense_key" UNIQUE("org_id","expense_id"),
	CONSTRAINT "expense_conversions_currency_iso" CHECK ("expense_conversions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_conversions_into_iso" CHECK ("expense_conversions"."reimbursement_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_conversions_two_currencies" CHECK ("expense_conversions"."currency" <> "expense_conversions"."reimbursement_currency"),
	CONSTRAINT "expense_conversions_rate_complete" CHECK (("expense_conversions"."outcome" = 'converted' AND "expense_conversions"."converted_minor" IS NOT NULL AND "expense_conversions"."rate" IS NOT NULL AND "expense_conversions"."rate" > 0 AND "expense_conversions"."rate_date" IS NOT NULL AND "expense_conversions"."rate_date" <= "expense_conversions"."purchase_date") OR ("expense_conversions"."outcome" = 'unavailable' AND "expense_conversions"."converted_minor" IS NULL AND "expense_conversions"."rate" IS NULL AND "expense_conversions"."rate_date" IS NULL)),
	CONSTRAINT "expense_conversions_source_named" CHECK (length(trim("expense_conversions"."source")) > 0)
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "reimbursement_currency" char(3);--> statement-breakpoint
ALTER TABLE "expense_conversions" ADD CONSTRAINT "expense_conversions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_conversions" ADD CONSTRAINT "expense_conversions_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_reimbursement_currency_iso" CHECK ("members"."reimbursement_currency" IS NULL OR "members"."reimbursement_currency" ~ '^[A-Z]{3}$');