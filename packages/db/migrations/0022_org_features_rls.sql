-- Features each organization's owner switches on or off (Q5, NFR-DEL-05). Hand-written
-- (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. A switch
-- is turned on or off, never deleted.
GRANT SELECT, INSERT, UPDATE ON org_features TO expensewise_app;
--> statement-breakpoint
ALTER TABLE org_features ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_features FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_features
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
