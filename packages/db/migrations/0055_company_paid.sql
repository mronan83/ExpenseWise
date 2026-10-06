ALTER TABLE "expense_types" ADD COLUMN "company_pays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "company_paid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "company_paid_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_drive_not_company_paid" CHECK ("expenses"."source" <> 'mileage' OR NOT "expenses"."company_paid");