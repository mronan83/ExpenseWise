-- An expense's conversion (ADR-0034) goes just before the expense does, while the expense is
-- still there to say whose it is. Deleting a receipt deletes its expense as the member who
-- asked (ADR-0028), and the own_records trigger on expense_conversions (migration 0035) finds
-- the conversion's owner through its expense; reached through the foreign key's cascade, the
-- expense is already gone and the member's own deletion was refused. The cascade stays as a
-- backstop. Hand-written (drizzle-kit --custom). Safe to run again.
CREATE OR REPLACE FUNCTION delete_expense_conversion() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM expense_conversions c WHERE c.org_id = OLD.org_id AND c.expense_id = OLD.id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_expense_conversion() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_conversion_first ON expenses;
--> statement-breakpoint
CREATE TRIGGER expense_conversion_first BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION delete_expense_conversion();
