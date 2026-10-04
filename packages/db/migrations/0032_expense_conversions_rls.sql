-- Amounts converted to each person's reimbursement currency (FR-EXP-13, ADR-0034).
-- Hand-written (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. A
-- conversion is recorded and replaced, never deleted by the app; it goes with its expense.
GRANT SELECT, INSERT, UPDATE ON expense_conversions TO expensewise_app;
--> statement-breakpoint
ALTER TABLE expense_conversions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_conversions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_conversions;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_conversions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- The organizations with amounts to convert at `as_of`: an open or closed report in another
-- currency than its member's, or an expense on one, its amount, currency and date known, in
-- another currency than the report's, with no conversion recorded for exactly that amount,
-- date and currency, and a purchase date before that day (UTC), whose rate is published. Only
-- organizations whose owner switched the feature on count, unless `every_org` says the
-- server's override has it on for all. The hourly sweep asks this, then converts inside each
-- organization as the app. It runs as its owner because the sweep is in no organization yet,
-- and answers with organization ids only, so the app still reads no tenant's rows outside
-- withOrg(). Statuses are compared as text: `closed` joined the enum earlier in the same
-- release, and a new enum value can't be used before it commits.
CREATE OR REPLACE FUNCTION conversion_work_due(as_of timestamptz, every_org boolean)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH switched AS (
    SELECT o.id AS org_id FROM organizations o
     WHERE every_org OR EXISTS (
       SELECT 1 FROM org_features f
        WHERE f.org_id = o.id AND f.flag = 'reports.currency-conversion' AND f.enabled)
  )
  SELECT r.org_id FROM reports r
    JOIN switched s ON s.org_id = r.org_id
    JOIN members m ON m.org_id = r.org_id AND m.id = r.member_id
    JOIN organizations o ON o.id = r.org_id
   WHERE r.status::text IN ('open', 'closed')
     AND r.currency <> coalesce(m.reimbursement_currency, o.home_currency)
  UNION
  SELECT r.org_id FROM reports r
    JOIN switched s ON s.org_id = r.org_id
    JOIN expenses e ON e.org_id = r.org_id
    LEFT JOIN trips t ON t.org_id = e.org_id AND t.id = e.trip_id
   WHERE r.status::text IN ('open', 'closed')
     AND (e.report_id = r.id OR t.report_id = r.id)
     AND e.amount_minor IS NOT NULL AND e.currency IS NOT NULL AND e.transaction_date IS NOT NULL
     AND e.currency <> r.currency
     AND e.transaction_date < (as_of AT TIME ZONE 'UTC')::date
     AND NOT EXISTS (
       SELECT 1 FROM expense_conversions c
        WHERE c.org_id = e.org_id AND c.expense_id = e.id
          AND c.amount_minor = e.amount_minor AND c.currency = e.currency
          AND c.purchase_date = e.transaction_date AND c.reimbursement_currency = r.currency)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION conversion_work_due(timestamptz, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION conversion_work_due(timestamptz, boolean) TO expensewise_app;
