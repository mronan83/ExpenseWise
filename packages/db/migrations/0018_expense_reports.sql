ALTER TYPE "public"."report_status" ADD VALUE 'closed' BEFORE 'submitted';--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_report_fk";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_trip_fk";
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "justification" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "closes_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "report_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_member_id_key" UNIQUE("org_id","member_id","id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_report_fk" FOREIGN KEY ("org_id","member_id","report_id") REFERENCES "public"."reports"("org_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_report_fk" FOREIGN KEY ("org_id","member_id","report_id") REFERENCES "public"."reports"("org_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trips_report_idx" ON "trips" USING btree ("org_id","report_id");--> statement-breakpoint
ALTER TABLE "reports" DROP COLUMN "trip_id";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_report_only_when_local" CHECK ("expenses"."report_id" IS NULL OR "expenses"."trip_id" IS NULL);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_closed_when_closed" CHECK (("reports"."status" = 'open') = ("reports"."closed_at" IS NULL));