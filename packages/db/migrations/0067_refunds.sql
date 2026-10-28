-- Refunds (FR-EXP-21, ADR-0054). A confirmed reading may be a refund's: its total below zero, its
-- tax and tip zero or less with it. A purchase's stay zero or more, as before.
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_amounts_one_sign" CHECK (("receipt_reviews"."total_minor" >= 0 AND coalesce("receipt_reviews"."tax_minor", 0) >= 0 AND coalesce("receipt_reviews"."tip_minor", 0) >= 0) OR ("receipt_reviews"."total_minor" < 0 AND coalesce("receipt_reviews"."tax_minor", 0) <= 0 AND coalesce("receipt_reviews"."tip_minor", 0) <= 0));--> statement-breakpoint
ALTER TABLE "receipt_reviews" DROP CONSTRAINT "receipt_reviews_amounts_not_negative";--> statement-breakpoint
-- The purchase a refund gives money back on, one of its member's own expenses. The key it points
-- at comes first, so the pairing can name it.
ALTER TABLE "expenses" ADD COLUMN "refund_of_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_member_id_key" UNIQUE("org_id","member_id","id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_refund_of_fk" FOREIGN KEY ("org_id","member_id","refund_of_id") REFERENCES "public"."expenses"("org_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_refund_of_idx" ON "expenses" USING btree ("org_id","refund_of_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_refund_below_zero" CHECK ("expenses"."refund_of_id" IS NULL OR ("expenses"."amount_minor" < 0 AND "expenses"."refund_of_id" <> "expenses"."id"));--> statement-breakpoint
-- Not valid yet: a refund read before refunds were held may be on a trip or a report, or Ready.
-- holdUnpairedRefunds() takes each one off, with its audit event, then validates this.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_refund_unpaired_held" CHECK ("expenses"."amount_minor" IS NULL OR "expenses"."amount_minor" >= 0 OR "expenses"."refund_of_id" IS NOT NULL OR "expenses"."status" IN ('submitted', 'approved', 'settled') OR ("expenses"."status" <> 'ready' AND "expenses"."trip_id" IS NULL AND "expenses"."report_id" IS NULL)) NOT VALID;
