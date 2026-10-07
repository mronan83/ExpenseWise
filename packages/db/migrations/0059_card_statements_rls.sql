-- A member's card statements and the transactions they bring in (FR-CAP-10, FR-INT-24, #97).
-- Hand-written (drizzle-kit --custom). Safe to run again.

-- Tenant data under the same forced row-level security as every other tenant table. A statement
-- brought in by mistake is deleted with its transactions, so the app may delete them; each change
-- is in the audit trail.
GRANT SELECT, INSERT, UPDATE, DELETE ON card_statements, card_transactions TO expensewise_app;
--> statement-breakpoint
ALTER TABLE card_statements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_statements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON card_statements;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON card_statements
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON card_transactions;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON card_transactions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- They are their member's own, as receipts are (ADR-0035): a member sees only their own, and a
-- change by anyone but that member, or by an auditor, is refused. The statement workflow acts
-- for the system, with no member named, so it still reads every member's statements.
DROP POLICY IF EXISTS own_records ON card_statements;
--> statement-breakpoint
CREATE POLICY own_records ON card_statements AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON card_transactions;
--> statement-breakpoint
CREATE POLICY own_records ON card_transactions AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON card_statements;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON card_statements
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON card_transactions;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON card_transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

-- An expense that is deleted lets go of its card transaction just before it goes, which is then
-- a missing receipt again (US-CAP-07 AC3), rather than blocking the deletion.
CREATE OR REPLACE FUNCTION release_card_transactions() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE card_transactions t
     SET expense_id = NULL, matched_by = NULL, matched_at = NULL
   WHERE t.org_id = OLD.org_id AND t.expense_id = OLD.id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION release_card_transactions() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS card_transactions_released ON expenses;
--> statement-breakpoint
CREATE TRIGGER card_transactions_released BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION release_card_transactions();
