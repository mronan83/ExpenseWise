CREATE TYPE "public"."inbound_email_problem" AS ENUM('unsigned', 'signature_failed', 'not_aligned', 'partly_signed');--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "sender_problem" "inbound_email_problem";--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_problem_unverified" CHECK ("inbound_emails"."sender_problem" is null or "inbound_emails"."status" = 'unverified');--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_dismissed_unfiled" CHECK ("inbound_emails"."dismissed_at" is null or "inbound_emails"."status" <> 'filed');