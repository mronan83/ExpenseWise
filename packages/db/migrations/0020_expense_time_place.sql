ALTER TABLE "expenses" ADD COLUMN "transaction_time" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "merchant_address" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "merchant_city" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "merchant_region" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "merchant_country" char(2);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_time_of_day" CHECK ("expenses"."transaction_time" IS NULL OR "expenses"."transaction_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_country_code" CHECK ("expenses"."merchant_country" IS NULL OR "expenses"."merchant_country" ~ '^[A-Z]{2}$');