CREATE TYPE "public"."matched_by" AS ENUM('auto', 'person');--> statement-breakpoint
CREATE TYPE "public"."set_aside_reason" AS ENUM('personal', 'no_receipt', 'not_an_expense', 'other');--> statement-breakpoint
CREATE TYPE "public"."statement_source" AS ENUM('upload', 'email', 'list');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('reading', 'read', 'needs_look', 'failed');--> statement-breakpoint
CREATE TABLE "card_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"source" "statement_source" NOT NULL,
	"storage_key" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"status" "statement_status" DEFAULT 'reading' NOT NULL,
	"problem" text,
	"card_last_four" text,
	"period_start" date,
	"period_end" date,
	"currency" char(3),
	"charges_minor" bigint,
	"credits_minor" bigint,
	"model" text,
	"version" text,
	"cost_nano_usd" bigint,
	"added" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_statements_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "card_statements_member_sha256_key" UNIQUE("org_id","member_id","sha256"),
	CONSTRAINT "card_statements_sha256_hex" CHECK ("card_statements"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "card_statements_byte_size_positive" CHECK ("card_statements"."byte_size" > 0),
	CONSTRAINT "card_statements_file_kept" CHECK (("card_statements"."storage_key" IS NULL) = ("card_statements"."source" = 'list')),
	CONSTRAINT "card_statements_currency_iso" CHECK ("card_statements"."currency" IS NULL OR "card_statements"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "card_statements_card_last_four" CHECK ("card_statements"."card_last_four" IS NULL OR "card_statements"."card_last_four" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"key" text NOT NULL,
	"transaction_date" date NOT NULL,
	"posted_on" date,
	"merchant" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"card_last_four" text,
	"reference" text,
	"expense_id" uuid,
	"matched_by" "matched_by",
	"matched_at" timestamp with time zone,
	"set_aside_reason" "set_aside_reason",
	"set_aside_note" text,
	"set_aside_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_transactions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "card_transactions_member_key" UNIQUE("org_id","member_id","key"),
	CONSTRAINT "card_transactions_currency_iso" CHECK ("card_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "card_transactions_card_last_four" CHECK ("card_transactions"."card_last_four" IS NULL OR "card_transactions"."card_last_four" ~ '^[0-9]{4}$'),
	CONSTRAINT "card_transactions_matched_whole" CHECK (("card_transactions"."expense_id" IS NULL AND "card_transactions"."matched_by" IS NULL AND "card_transactions"."matched_at" IS NULL) OR ("card_transactions"."expense_id" IS NOT NULL AND "card_transactions"."matched_by" IS NOT NULL AND "card_transactions"."matched_at" IS NOT NULL)),
	CONSTRAINT "card_transactions_set_aside_whole" CHECK (("card_transactions"."set_aside_reason" IS NULL AND "card_transactions"."set_aside_note" IS NULL AND "card_transactions"."set_aside_at" IS NULL) OR ("card_transactions"."set_aside_reason" IS NOT NULL AND "card_transactions"."set_aside_at" IS NOT NULL)),
	CONSTRAINT "card_transactions_matched_or_set_aside" CHECK ("card_transactions"."expense_id" IS NULL OR "card_transactions"."set_aside_reason" IS NULL),
	CONSTRAINT "card_transactions_other_needs_note" CHECK ("card_transactions"."set_aside_reason" IS DISTINCT FROM 'other' OR coalesce(length(trim("card_transactions"."set_aside_note")), 0) > 0),
	CONSTRAINT "card_transactions_note_length" CHECK ("card_transactions"."set_aside_note" IS NULL OR char_length("card_transactions"."set_aside_note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_statement_fk" FOREIGN KEY ("org_id","statement_id") REFERENCES "public"."card_statements"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_transactions_expense_key" ON "card_transactions" USING btree ("org_id","expense_id") WHERE "card_transactions"."expense_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "card_transactions_member_open_idx" ON "card_transactions" USING btree ("org_id","member_id","transaction_date");