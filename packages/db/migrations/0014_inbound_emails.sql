CREATE TYPE "public"."inbound_email_status" AS ENUM('filed', 'no_attachments', 'unverified');--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text,
	"sent_at" timestamp with time zone,
	"status" "inbound_email_status" NOT NULL,
	"body_text" text,
	"receipt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_emails_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "inbound_emails_message_key" UNIQUE("org_id","provider","provider_message_id"),
	CONSTRAINT "inbound_emails_receipt_count" CHECK ("inbound_emails"."receipt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_emails_member_idx" ON "inbound_emails" USING btree ("org_id","member_id","created_at");