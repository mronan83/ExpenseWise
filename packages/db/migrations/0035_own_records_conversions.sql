-- An expense's conversion (ADR-0034) is that expense's member's, like everything else that
-- hangs off an expense (ADR-0035): a member sees only their own, and a change by anyone but
-- that member, or by an auditor, is refused. The conversion workflow acts for the system, with
-- no member named, so it still converts every member's amounts. Hand-written (drizzle-kit
-- --custom). Safe to run again.
DROP POLICY IF EXISTS own_records ON expense_conversions;
--> statement-breakpoint
CREATE POLICY own_records ON expense_conversions AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_conversions.org_id AND e.id = expense_conversions.expense_id));
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_conversions;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_conversions
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
