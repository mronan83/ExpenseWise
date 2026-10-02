CREATE TABLE "member_sign_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_sign_ins_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "member_sign_ins_user_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "member_sign_ins" ADD CONSTRAINT "member_sign_ins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_sign_ins" ADD CONSTRAINT "member_sign_ins_member_fk" FOREIGN KEY ("org_id","member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_sign_ins_member_idx" ON "member_sign_ins" USING btree ("org_id","member_id");