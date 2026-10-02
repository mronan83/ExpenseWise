-- AI provider keys and membership lookup (ADR-0015). Hand-written (drizzle-kit --custom).

-- Provider keys are tenant data under the same forced row-level security as every other
-- tenant table. The application only ever reads and writes ciphertext.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_provider_keys TO expensewise_app;
--> statement-breakpoint
ALTER TABLE ai_provider_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_provider_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_provider_keys
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- The signed-in user for the current transaction, set by withUser() from a verified access
-- token via set_config('app.user_id', ..., true). No setting means no user.
CREATE OR REPLACE FUNCTION app_current_user() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
-- New functions are executable by PUBLIC, which includes the Data API roles (see 0002).
REVOKE ALL ON FUNCTION app_current_user() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user() TO expensewise_app;
--> statement-breakpoint

-- Before an organization is chosen, the API must find the caller's memberships, which the
-- tenant policy hides. This read-only policy shows a user their own member rows in any
-- organization, and nothing else. Policies combine with OR, so tenant isolation is unchanged
-- for every other row.
CREATE POLICY own_memberships ON members FOR SELECT
  USING (user_id = app_current_user());
