-- Possible duplicates (FR-INT-18, ADR-0028). Hand-written (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. The app
-- opens a pair and dismisses it; only delete_receipt() removes one.
GRANT SELECT, INSERT, UPDATE ON receipt_duplicates TO expensewise_app;
--> statement-breakpoint
ALTER TABLE receipt_duplicates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE receipt_duplicates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON receipt_duplicates
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Receipts, their readings and expenses were deletable by the app since 0001, though nothing
-- deletes them. From now the only way is delete_receipt(), so a deletion always takes the whole
-- receipt and is always a decision about a duplicate.
REVOKE DELETE ON receipts, extraction_runs, expenses FROM expensewise_app;
--> statement-breakpoint

-- Deletes a receipt the person chose to delete as a duplicate, with its readings, its
-- confirmations, its pairs and the expense it proves. Readings and confirmations stay
-- append-only to the app otherwise. It works only inside the organization the transaction is
-- in, and refuses an expense that is submitted or later, which stays as it is (corrections to
-- those are reversals). The caller writes the audit events in the same transaction, then
-- removes the file with the storage key returned.
CREATE FUNCTION delete_receipt(target uuid)
  RETURNS TABLE (storage_key text, expense_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    doomed receipts%ROWTYPE;
    claim expense_status;
  BEGIN
    SELECT * INTO doomed FROM receipts r
     WHERE r.id = target AND r.org_id = app_current_org()
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    IF doomed.expense_id IS NOT NULL THEN
      SELECT e.status INTO claim FROM expenses e
       WHERE e.org_id = doomed.org_id AND e.id = doomed.expense_id
         FOR UPDATE;
      IF claim IN ('submitted', 'approved', 'settled') THEN
        RAISE EXCEPTION 'The expense of receipt % is %, so the receipt can''t be deleted', target, claim
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    DELETE FROM receipt_duplicates d
     WHERE d.org_id = doomed.org_id AND (d.receipt_id = target OR d.other_receipt_id = target);
    DELETE FROM receipt_reviews v WHERE v.org_id = doomed.org_id AND v.receipt_id = target;
    DELETE FROM extraction_runs x WHERE x.org_id = doomed.org_id AND x.receipt_id = target;
    DELETE FROM receipts r WHERE r.org_id = doomed.org_id AND r.id = target;
    IF doomed.expense_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM receipts r WHERE r.org_id = doomed.org_id AND r.expense_id = doomed.expense_id
    ) THEN
      DELETE FROM expenses e WHERE e.org_id = doomed.org_id AND e.id = doomed.expense_id;
    END IF;
    storage_key := doomed.storage_key;
    expense_id := doomed.expense_id;
    RETURN NEXT;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_receipt(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_receipt(uuid) TO expensewise_app;
