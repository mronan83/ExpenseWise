-- Saved routes (FR-CAP-16, #110): a member's routes to log drives from, and their stops.
-- Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Tenant data under the same forced row-level security as every other tenant table, and a
-- member's own, as saved places are (ADR-0035): the restrictive own_records policy and
-- trigger let a member see and change only their own. A route and its stops can be removed;
-- removing a route removes its stops with it.

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_routes TO expensewise_app;
--> statement-breakpoint
ALTER TABLE saved_routes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON saved_routes;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON saved_routes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON saved_routes;
--> statement-breakpoint
CREATE POLICY own_records ON saved_routes AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON saved_routes;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON saved_routes
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_route_stops TO expensewise_app;
--> statement-breakpoint
ALTER TABLE saved_route_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_route_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON saved_route_stops;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON saved_route_stops
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON saved_route_stops;
--> statement-breakpoint
CREATE POLICY own_records ON saved_route_stops AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON saved_route_stops;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON saved_route_stops
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
