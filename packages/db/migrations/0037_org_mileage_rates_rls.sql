-- The rate a mile each organization pays drives at, set by its owner or a finance admin (Q28,
-- #77). Hand-written (drizzle-kit --custom). Safe to run again.

-- Tenant data under the same forced row-level security as every other tenant table. It is the
-- organization's, not one member's, so every member reads it, as pricing their drives needs. A
-- change for a day is set again, never deleted, so the app needs no DELETE.
GRANT SELECT, INSERT, UPDATE ON org_mileage_rates TO expensewise_app;
--> statement-breakpoint
ALTER TABLE org_mileage_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_mileage_rates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON org_mileage_rates;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_mileage_rates
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
