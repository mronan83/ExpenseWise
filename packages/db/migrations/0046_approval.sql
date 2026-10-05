ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_org_id_id_key" UNIQUE("org_id","id");--> statement-breakpoint
CREATE TABLE "expense_rejections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_rejections_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_rejections_step_expense_key" UNIQUE("org_id","step_id","expense_id"),
	CONSTRAINT "expense_rejections_reason_length" CHECK (char_length(trim("expense_rejections"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "expense_parts" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "expense_parts" ADD COLUMN "type_name" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "claim_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "type_name" text;--> statement-breakpoint
ALTER TABLE "expense_rejections" ADD CONSTRAINT "expense_rejections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rejections" ADD CONSTRAINT "expense_rejections_step_fk" FOREIGN KEY ("org_id","step_id") REFERENCES "public"."approval_steps"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rejections" ADD CONSTRAINT "expense_rejections_expense_fk" FOREIGN KEY ("org_id","expense_id") REFERENCES "public"."expenses"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_rejections_expense_idx" ON "expense_rejections" USING btree ("org_id","expense_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_claim_reason_length" CHECK ("expenses"."claim_reason" IS NULL OR char_length("expenses"."claim_reason") BETWEEN 1 AND 500);