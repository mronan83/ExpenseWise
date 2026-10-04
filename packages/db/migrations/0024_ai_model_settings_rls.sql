-- Which AI models read each organization's receipts (FR-INT-16, ADR-0033). Hand-written
-- (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. A model
-- is switched on or off and moved, never deleted, so the app needs no DELETE.
GRANT SELECT, INSERT, UPDATE ON org_ai_models TO expensewise_app;
--> statement-breakpoint
ALTER TABLE org_ai_models ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_ai_models FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON org_ai_models;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_ai_models
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
