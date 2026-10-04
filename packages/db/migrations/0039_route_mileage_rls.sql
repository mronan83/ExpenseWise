-- Route-based mileage (FR-CAP-04, #20, ADR-0039): the organization's routing key, members'
-- saved places, and each route drive with its stops. Hand-written (drizzle-kit --custom).
-- Safe to run again.
--
-- Tenant data under the same forced row-level security as every other tenant table. Saved
-- places are a member's own, and a drive's route and stops hang off its expense, so each
-- also gets the restrictive own_records policy and trigger (ADR-0035): a member sees and
-- changes only their own, and the measuring workflow, which names no member, acts for the
-- system.

-- The key is replaced or removed by an owner or finance admin, which the API checks.
GRANT SELECT, INSERT, UPDATE, DELETE ON route_service_keys TO expensewise_app;
--> statement-breakpoint
ALTER TABLE route_service_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE route_service_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON route_service_keys;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON route_service_keys
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- A saved place is a convenience a member keeps, not a claim: it can be removed.
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_places TO expensewise_app;
--> statement-breakpoint
ALTER TABLE saved_places ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_places FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON saved_places;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON saved_places
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON saved_places;
--> statement-breakpoint
CREATE POLICY own_records ON saved_places AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON saved_places;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON saved_places
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

-- One route per drive, changed as the drive is, never deleted.
GRANT SELECT, INSERT, UPDATE ON mileage_routes TO expensewise_app;
--> statement-breakpoint
ALTER TABLE mileage_routes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mileage_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON mileage_routes;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mileage_routes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON mileage_routes;
--> statement-breakpoint
CREATE POLICY own_records ON mileage_routes AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = mileage_routes.org_id AND e.id = mileage_routes.expense_id));
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON mileage_routes;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON mileage_routes
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint

-- A drive's stops are replaced whole when the person changes them before it is submitted;
-- the audit trail keeps what they were.
GRANT SELECT, INSERT, UPDATE, DELETE ON mileage_route_stops TO expensewise_app;
--> statement-breakpoint
ALTER TABLE mileage_route_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mileage_route_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON mileage_route_stops;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mileage_route_stops
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON mileage_route_stops;
--> statement-breakpoint
CREATE POLICY own_records ON mileage_route_stops AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = mileage_route_stops.org_id AND e.id = mileage_route_stops.expense_id));
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON mileage_route_stops;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON mileage_route_stops
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
