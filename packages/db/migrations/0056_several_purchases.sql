CREATE TABLE "expense_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"purchased_on" date,
	"card_last_four" text,
	"total_minor" bigint,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_purchases_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_purchases_position_key" UNIQUE("org_id","expense_id","position"),
	CONSTRAINT "expense_purchases_position_positive" CHECK ("expense_purchases"."position" > 0),
	CONSTRAINT "expense_purchases_currency_iso" CHECK ("expense_purchases"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_purchases_card_last_four" CHECK ("expense_purchases"."card_last_four" IS NULL OR "expense_purchases"."card_last_four" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "expense_lines" ADD COLUMN "purchase" integer;--> statement-breakpoint
ALTER TABLE "expense_purchases" ADD CONSTRAINT "expense_purchases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_purchases" ADD CONSTRAINT "expense_purchases_itemization_fk" FOREIGN KEY ("org_id","expense_id","currency") REFERENCES "public"."expense_itemizations"("org_id","expense_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_purchase_fk" FOREIGN KEY ("org_id","expense_id","purchase") REFERENCES "public"."expense_purchases"("org_id","expense_id","position") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_purchase_positive" CHECK ("expense_lines"."purchase" IS NULL OR "expense_lines"."purchase" > 0);