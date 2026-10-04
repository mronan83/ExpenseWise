-- A receipt's itemized lines on its expense, and the parts a split expense is made of
-- (FR-INT-22, FR-EXP-15, FR-EXP-16, ADR-0041). Hand-written (drizzle-kit --custom). Safe to
-- run again.

-- Tenant data under the same forced row-level security as every other tenant table. The lines
-- are replaced when a new reading is copied on, and the parts whenever a split or an exclusion
-- changes them, so the app may delete them; each change is in the audit trail. They go with
-- their expense when that is deleted.
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_itemizations, expense_lines, expense_parts
  TO expensewise_app;
--> statement-breakpoint
ALTER TABLE expense_itemizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_itemizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_parts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_parts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_itemizations;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_itemizations
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_lines;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_lines
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_parts;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_parts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- They are their expense's member's, like everything else that hangs off an expense
-- (ADR-0035): a member sees only their own, and a change by anyone but that member, or by an
-- auditor, is refused. The reading workflow acts for the system, with no member named, so it
-- still copies every member's lines.
DROP POLICY IF EXISTS own_records ON expense_itemizations;
--> statement-breakpoint
CREATE POLICY own_records ON expense_itemizations AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_itemizations.org_id AND e.id = expense_itemizations.expense_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON expense_lines;
--> statement-breakpoint
CREATE POLICY own_records ON expense_lines AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_lines.org_id AND e.id = expense_lines.expense_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON expense_parts;
--> statement-breakpoint
CREATE POLICY own_records ON expense_parts AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_parts.org_id AND e.id = expense_parts.expense_id));
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_itemizations;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_itemizations
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_lines;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_parts;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_parts
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint

-- An expense's lines and parts go just before it does, while it is still there to say whose
-- they are: deleting a receipt deletes its expense as the member who asked (ADR-0028), and the
-- own_records trigger on each line finds its owner through the expense. The foreign keys'
-- cascade stays as a backstop.
CREATE OR REPLACE FUNCTION delete_expense_lines() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM expense_parts p WHERE p.org_id = OLD.org_id AND p.expense_id = OLD.id;
  DELETE FROM expense_itemizations i WHERE i.org_id = OLD.org_id AND i.expense_id = OLD.id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_expense_lines() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_lines_first ON expenses;
--> statement-breakpoint
CREATE TRIGGER expense_lines_first BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION delete_expense_lines();
