-- The purchases a receipt of several holds, on its expense (FR-INT-23, Q49, #96).
-- Hand-written (drizzle-kit --custom). Safe to run again.

-- Tenant data under the same forced row-level security as the lines it groups (0042): replaced
-- with them when a new reading is copied on, and gone with their itemization, so the app may
-- delete them; each copy is in the audit trail.
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_purchases TO expensewise_app;
--> statement-breakpoint
ALTER TABLE expense_purchases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_purchases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_purchases;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_purchases
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Their expense's member's, like everything else that hangs off an expense (ADR-0035): a member
-- sees only their own, and a change by anyone but that member, or by an auditor, is refused.
-- The reading workflow acts for the system, so it still copies every member's purchases. They
-- go with their itemization, which goes just before its expense (delete_expense_lines()), while
-- the expense is still there to say whose they are.
DROP POLICY IF EXISTS own_records ON expense_purchases;
--> statement-breakpoint
CREATE POLICY own_records ON expense_purchases AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_purchases.org_id AND e.id = expense_purchases.expense_id));
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_purchases;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_purchases
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
