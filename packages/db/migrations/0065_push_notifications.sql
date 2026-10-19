CREATE TYPE "public"."notification_kind" AS ENUM('receipts', 'needs_look', 'reports', 'approvals', 'decisions', 'card', 'drives', 'test');--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notification_preferences_kind_key" UNIQUE("org_id","member_id","kind")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"tries" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "notifications_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notifications_dedupe_key" UNIQUE("org_id","member_id","dedupe_key"),
	CONSTRAINT "notifications_text_length" CHECK (length("notifications"."title") BETWEEN 1 AND 80 AND length("notifications"."body") BETWEEN 1 AND 200),
	CONSTRAINT "notifications_url_path" CHECK ("notifications"."url" LIKE '/%' AND "notifications"."url" NOT LIKE '//%'),
	CONSTRAINT "notifications_tries_range" CHECK ("notifications"."tries" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "push_cursors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_cursors_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "push_cursors_org_key" UNIQUE("org_id"),
	CONSTRAINT "push_cursors_sequence_range" CHECK ("push_cursors"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"time_zone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE("org_id","member_id","endpoint"),
	CONSTRAINT "push_subscriptions_endpoint_https" CHECK ("push_subscriptions"."endpoint" LIKE 'https://%' AND length("push_subscriptions"."endpoint") <= 1024),
	CONSTRAINT "push_subscriptions_keys_length" CHECK (length("push_subscriptions"."p256dh") = 87 AND length("push_subscriptions"."auth") = 22)
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_cursors" ADD CONSTRAINT "push_cursors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_unsent_idx" ON "notifications" USING btree ("org_id","created_at") WHERE sent_at IS NULL;