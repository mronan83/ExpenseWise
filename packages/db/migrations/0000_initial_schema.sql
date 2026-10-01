CREATE TYPE "public"."actor_type" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'returned');--> statement-breakpoint
CREATE TYPE "public"."distance_unit" AS ENUM('mi', 'km');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('camera', 'upload', 'email', 'card', 'manual', 'mileage');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('processing', 'needs_review', 'ready', 'submitted', 'approved', 'settled');--> statement-breakpoint
CREATE TYPE "public"."extraction_outcome" AS ENUM('confident', 'unsure', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'approver', 'finance_admin', 'owner', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."mileage_method" AS ENUM('manual', 'route', 'gps');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('processing', 'extracted', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'submitted', 'in_approval', 'approved', 'settled');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('planned', 'active', 'closed');--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"approver_member_id" uuid NOT NULL,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_steps_report_sequence_key" UNIQUE("org_id","report_id","sequence"),
	CONSTRAINT "approval_steps_return_needs_comment" CHECK ("approval_steps"."decision" <> 'returned' OR length(trim(coalesce("approval_steps"."comment", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"hash" char(64) NOT NULL,
	CONSTRAINT "audit_events_org_sequence_key" UNIQUE("org_id","sequence"),
	CONSTRAINT "audit_events_hash_key" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gl_code" text,
	"tax_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "categories_org_name_key" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"trip_id" uuid,
	"report_id" uuid,
	"category_id" uuid,
	"status" "expense_status" NOT NULL,
	"source" "expense_source" NOT NULL,
	"merchant" text,
	"transaction_date" date,
	"amount_minor" bigint,
	"currency" char(3),
	"home_amount_minor" bigint,
	"fx_rate" numeric(20, 10),
	"fx_rate_date" date,
	"fx_source" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expenses_currency_iso" CHECK ("expenses"."currency" IS NULL OR "expenses"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expenses_complete_when_ready" CHECK ("expenses"."status" IN ('processing', 'needs_review') OR ("expenses"."amount_minor" IS NOT NULL AND "expenses"."currency" IS NOT NULL AND "expenses"."transaction_date" IS NOT NULL)),
	CONSTRAINT "expenses_fx_complete" CHECK (("expenses"."fx_rate" IS NULL AND "expenses"."fx_rate_date" IS NULL AND "expenses"."fx_source" IS NULL) OR ("expenses"."fx_rate" IS NOT NULL AND "expenses"."fx_rate_date" IS NOT NULL AND "expenses"."fx_source" IS NOT NULL AND "expenses"."home_amount_minor" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"extractor" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"outcome" "extraction_outcome" NOT NULL,
	"output" jsonb,
	"field_confidence" jsonb,
	"error" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micro_usd" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"manager_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "members_org_user_key" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mileage_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"method" "mileage_method" NOT NULL,
	"travel_date" date NOT NULL,
	"purpose" text NOT NULL,
	"origin" text,
	"destination" text,
	"waypoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distance" numeric(10, 2) NOT NULL,
	"unit" "distance_unit" NOT NULL,
	"rate_currency" char(3) NOT NULL,
	"rate_per_unit" numeric(12, 4) NOT NULL,
	"rate_effective_from" date NOT NULL,
	"rate_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_logs_expense_key" UNIQUE("org_id","expense_id"),
	CONSTRAINT "mileage_logs_distance_nonnegative" CHECK ("mileage_logs"."distance" >= 0),
	CONSTRAINT "mileage_logs_rate_currency_iso" CHECK ("mileage_logs"."rate_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"home_currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_home_currency_iso" CHECK ("organizations"."home_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"expense_id" uuid,
	"source" "expense_source" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"perceptual_hash" text,
	"status" "receipt_status" DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "receipts_org_sha256_key" UNIQUE("org_id","sha256"),
	CONSTRAINT "receipts_sha256_hex" CHECK ("receipts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receipts_byte_size_positive" CHECK ("receipts"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"trip_id" uuid,
	"title" text NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"currency" char(3) NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "reports_currency_iso" CHECK ("reports"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"primary_city" text,
	"status" "trip_status" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "trips_dates_ordered" CHECK ("trips"."end_date" >= "trips"."start_date")
);
--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_report_fk" FOREIGN KEY ("org_id","report_id") REFERENCES "public"."reports"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_fk" FOREIGN KEY ("org_id","approver_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_fk" FOREIGN KEY ("org_id","trip_id") REFERENCES "public"."trips"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_report_fk" FOREIGN KEY ("org_id","report_id") REFERENCES "public"."reports"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reversal_fk" FOREIGN KEY ("org_id","reversal_of_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_receipt_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "public"."receipts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_manager_fk" FOREIGN KEY ("org_id","manager_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD CONSTRAINT "mileage_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD CONSTRAINT "mileage_logs_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_trip_fk" FOREIGN KEY ("org_id","trip_id") REFERENCES "public"."trips"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "expenses_member_date_idx" ON "expenses" USING btree ("org_id","member_id","transaction_date");--> statement-breakpoint
CREATE INDEX "expenses_trip_idx" ON "expenses" USING btree ("org_id","trip_id");--> statement-breakpoint
CREATE INDEX "expenses_report_idx" ON "expenses" USING btree ("org_id","report_id");--> statement-breakpoint
CREATE INDEX "expenses_status_idx" ON "expenses" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "extraction_runs_receipt_idx" ON "extraction_runs" USING btree ("org_id","receipt_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("created_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX "reports_member_status_idx" ON "reports" USING btree ("org_id","member_id","status");--> statement-breakpoint
CREATE INDEX "trips_member_dates_idx" ON "trips" USING btree ("org_id","member_id","start_date");