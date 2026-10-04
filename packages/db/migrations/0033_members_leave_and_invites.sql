CREATE TABLE "member_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"label" text,
	"token_hash" char(64) NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_member_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_invites_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "member_invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "member_invites_token_hash_hex" CHECK ("member_invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "member_invites_accepted_by_someone" CHECK (("member_invites"."accepted_at" IS NULL) = ("member_invites"."accepted_by_member_id" IS NULL)),
	CONSTRAINT "member_invites_accepted_or_revoked" CHECK ("member_invites"."accepted_at" IS NULL OR "member_invites"."revoked_at" IS NULL),
	CONSTRAINT "member_invites_expires_after_made" CHECK ("member_invites"."expires_at" > "member_invites"."created_at"),
	CONSTRAINT "member_invites_label_short" CHECK ("member_invites"."label" IS NULL OR length("member_invites"."label") <= 80)
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_created_by_fk" FOREIGN KEY ("org_id","created_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_accepted_by_fk" FOREIGN KEY ("org_id","accepted_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_invites_org_created_idx" ON "member_invites" USING btree ("org_id","created_at");