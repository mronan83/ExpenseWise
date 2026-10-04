CREATE TABLE "category_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_types_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "category_types_pair_key" UNIQUE("org_id","category_id","type_id")
);
--> statement-breakpoint
CREATE TABLE "expense_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starter_key" text,
	"updated_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_types_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "expense_types_org_name_key" UNIQUE("org_id","name"),
	CONSTRAINT "expense_types_org_starter_key" UNIQUE("org_id","starter_key"),
	CONSTRAINT "expense_types_not_own_parent" CHECK ("expense_types"."parent_id" IS NULL OR "expense_types"."parent_id" <> "expense_types"."id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "starter_key" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "updated_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "type_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "category_types" ADD CONSTRAINT "category_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_types" ADD CONSTRAINT "category_types_category_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_types" ADD CONSTRAINT "category_types_type_fk" FOREIGN KEY ("org_id","type_id") REFERENCES "public"."expense_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_parent_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."expense_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_types_type_idx" ON "category_types" USING btree ("org_id","type_id");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_type_fk" FOREIGN KEY ("org_id","type_id") REFERENCES "public"."expense_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_member_classified_idx" ON "expenses" USING btree ("org_id","member_id","classified_at");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_starter_key" UNIQUE("org_id","starter_key");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_classified_whole" CHECK (("expenses"."category_id" IS NULL AND "expenses"."type_id" IS NULL AND "expenses"."classified_at" IS NULL) OR ("expenses"."category_id" IS NOT NULL AND "expenses"."type_id" IS NOT NULL AND "expenses"."classified_at" IS NOT NULL));