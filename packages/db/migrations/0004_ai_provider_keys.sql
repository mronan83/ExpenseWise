CREATE TYPE "public"."ai_auth_scheme" AS ENUM('api_key', 'bearer');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai');--> statement-breakpoint
CREATE TABLE "ai_provider_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"ciphertext" text NOT NULL,
	"key_hint" text NOT NULL,
	"auth_scheme" "ai_auth_scheme" NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_keys_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "ai_provider_keys_org_provider_key" UNIQUE("org_id","provider"),
	CONSTRAINT "ai_provider_keys_hint_short" CHECK (length("ai_provider_keys"."key_hint") <= 4)
);
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_updated_by_fk" FOREIGN KEY ("org_id","updated_by_member_id") REFERENCES "public"."members"("org_id","id") ON DELETE no action ON UPDATE no action;