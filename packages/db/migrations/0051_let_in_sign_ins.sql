CREATE TABLE "let_in_sign_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sign_in_id" uuid NOT NULL,
	"let_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"passed_at" timestamp with time zone,
	"lapses_at" timestamp with time zone,
	CONSTRAINT "let_in_sign_ins_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "let_in_sign_ins_sign_in_key" UNIQUE("org_id","sign_in_id"),
	CONSTRAINT "let_in_sign_ins_passed_or_waiting" CHECK (("let_in_sign_ins"."passed_at" IS NULL) <> ("let_in_sign_ins"."lapses_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "let_in_sign_ins" ADD CONSTRAINT "let_in_sign_ins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "let_in_sign_ins" ADD CONSTRAINT "let_in_sign_ins_sign_in_fk" FOREIGN KEY ("org_id","sign_in_id") REFERENCES "public"."member_sign_ins"("org_id","id") ON DELETE cascade ON UPDATE no action;