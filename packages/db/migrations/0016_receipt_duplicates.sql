CREATE TYPE "public"."duplicate_state" AS ENUM('open', 'dismissed');--> statement-breakpoint
CREATE TABLE "receipt_duplicates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"other_receipt_id" uuid NOT NULL,
	"state" "duplicate_state" DEFAULT 'open' NOT NULL,
	"settled_status" "receipt_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "receipt_duplicates_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "receipt_duplicates_pair_key" UNIQUE("org_id","receipt_id","other_receipt_id"),
	CONSTRAINT "receipt_duplicates_two_receipts" CHECK ("receipt_duplicates"."receipt_id" <> "receipt_duplicates"."other_receipt_id")
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "duplicates_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipt_duplicates" ADD CONSTRAINT "receipt_duplicates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_duplicates" ADD CONSTRAINT "receipt_duplicates_receipt_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "public"."receipts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_duplicates" ADD CONSTRAINT "receipt_duplicates_other_fk" FOREIGN KEY ("org_id","other_receipt_id") REFERENCES "public"."receipts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_duplicates_other_idx" ON "receipt_duplicates" USING btree ("org_id","other_receipt_id");