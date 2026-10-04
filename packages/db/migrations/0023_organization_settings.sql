CREATE TYPE "public"."organization_size" AS ENUM('just_me', '2_10', '11_50', '51_200', '201_1000', 'over_1000');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "country" char(2);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "size" "organization_size";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "duplicate_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_country_code" CHECK ("organizations"."country" IS NULL OR "organizations"."country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_duplicate_window_range" CHECK ("organizations"."duplicate_window_minutes" IS NULL OR "organizations"."duplicate_window_minutes" BETWEEN 0 AND 120);