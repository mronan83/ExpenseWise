CREATE TABLE "receipt_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"request_id" uuid,
	"model" text NOT NULL,
	"merchant" text NOT NULL,
	"transaction_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"total_minor" bigint NOT NULL,
	"tax_minor" bigint,
	"tip_minor" bigint,
	"corrections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_reviews_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "receipt_reviews_currency_code" CHECK ("receipt_reviews"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "receipt_reviews_amounts_not_negative" CHECK ("receipt_reviews"."total_minor" >= 0 AND coalesce("receipt_reviews"."tax_minor", 0) >= 0 AND coalesce("receipt_reviews"."tip_minor", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_receipt_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "public"."receipts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_reviews_receipt_idx" ON "receipt_reviews" USING btree ("org_id","receipt_id");