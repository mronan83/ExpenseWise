CREATE TYPE "public"."exclusion_reason" AS ENUM('personal', 'paid_by_someone_else', 'not_reimbursable', 'other');--> statement-breakpoint
CREATE TYPE "public"."line_kind" AS ENUM('item', 'tax', 'fee', 'tip');--> statement-breakpoint
CREATE TYPE "public"."split_basis" AS ENUM('lines', 'amounts');--> statement-breakpoint
CREATE TABLE "expense_itemizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"total_minor" bigint,
	"subtotal_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_itemizations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_itemizations_expense_key" UNIQUE("org_id","expense_id"),
	CONSTRAINT "expense_itemizations_expense_currency_key" UNIQUE("org_id","expense_id","currency"),
	CONSTRAINT "expense_itemizations_currency_iso" CHECK ("expense_itemizations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "expense_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"excluded_reason" "exclusion_reason",
	"excluded_note" text,
	"excluded_at" timestamp with time zone,
	"category_id" uuid,
	"type_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_lines_position_key" UNIQUE("org_id","expense_id","position"),
	CONSTRAINT "expense_lines_position_positive" CHECK ("expense_lines"."position" > 0),
	CONSTRAINT "expense_lines_currency_iso" CHECK ("expense_lines"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_lines_items_only" CHECK ("expense_lines"."kind" = 'item' OR ("expense_lines"."excluded_reason" IS NULL AND "expense_lines"."category_id" IS NULL)),
	CONSTRAINT "expense_lines_excluded_whole" CHECK (("expense_lines"."excluded_reason" IS NULL AND "expense_lines"."excluded_note" IS NULL AND "expense_lines"."excluded_at" IS NULL) OR ("expense_lines"."excluded_reason" IS NOT NULL AND "expense_lines"."excluded_at" IS NOT NULL)),
	CONSTRAINT "expense_lines_other_needs_note" CHECK ("expense_lines"."excluded_reason" IS DISTINCT FROM 'other' OR coalesce(length(trim("expense_lines"."excluded_note")), 0) > 0),
	CONSTRAINT "expense_lines_note_length" CHECK ("expense_lines"."excluded_note" IS NULL OR char_length("expense_lines"."excluded_note") <= 200),
	CONSTRAINT "expense_lines_split_whole" CHECK (("expense_lines"."category_id" IS NULL AND "expense_lines"."type_id" IS NULL) OR ("expense_lines"."category_id" IS NOT NULL AND "expense_lines"."type_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "expense_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"basis" "split_basis" NOT NULL,
	"category_id" uuid,
	"type_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_parts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_parts_position_key" UNIQUE("org_id","expense_id","position"),
	CONSTRAINT "expense_parts_position_positive" CHECK ("expense_parts"."position" > 0),
	CONSTRAINT "expense_parts_currency_iso" CHECK ("expense_parts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_parts_amount_positive" CHECK ("expense_parts"."amount_minor" > 0),
	CONSTRAINT "expense_parts_classified_whole" CHECK (("expense_parts"."category_id" IS NULL AND "expense_parts"."type_id" IS NULL) OR ("expense_parts"."category_id" IS NOT NULL AND "expense_parts"."type_id" IS NOT NULL)),
	CONSTRAINT "expense_parts_amounts_classified" CHECK ("expense_parts"."basis" = 'lines' OR "expense_parts"."category_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "expense_itemizations" ADD CONSTRAINT "expense_itemizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_itemizations" ADD CONSTRAINT "expense_itemizations_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_itemization_fk" FOREIGN KEY ("org_id","expense_id","currency") REFERENCES "public"."expense_itemizations"("org_id","expense_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_category_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_type_fk" FOREIGN KEY ("org_id","type_id") REFERENCES "public"."expense_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_category_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD CONSTRAINT "expense_parts_type_fk" FOREIGN KEY ("org_id","type_id") REFERENCES "public"."expense_types"("org_id","id") ON DELETE no action ON UPDATE no action;