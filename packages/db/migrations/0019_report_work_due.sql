-- Expense reports (FR-EXP-05, FR-EXP-12, FR-EXP-14, ADR-0029). Hand-written (drizzle-kit --custom).

-- The organizations with report work due at `as_of`: a trip or local expense whose time to
-- join a report has come, or an open report on or past its day 28, or one left with nothing
-- to claim (no local expense, and no trip with expenses). The hourly schedule asks this,
-- then does the work inside each organization as the app. It runs as its owner because the
-- schedule is in no organization yet, and answers with organization ids only, so the app
-- still reads no tenant's rows outside withOrg().
-- Something joins at noon UTC two days after its date (joinsReportAt() in the domain).
CREATE FUNCTION report_work_due(as_of timestamptz) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.org_id FROM trips t
   WHERE t.report_id IS NULL
     AND ((t.end_date + 2)::timestamp + interval '12 hours') AT TIME ZONE 'UTC' <= as_of
     AND EXISTS (
       SELECT 1 FROM expenses e
        WHERE e.org_id = t.org_id AND e.trip_id = t.id
          AND e.status IN ('processing', 'needs_review', 'ready'))
  UNION
  SELECT e.org_id FROM expenses e
   WHERE e.trip_id IS NULL AND e.report_id IS NULL AND e.transaction_date IS NOT NULL
     AND e.status IN ('needs_review', 'ready')
     AND ((e.transaction_date + 2)::timestamp + interval '12 hours') AT TIME ZONE 'UTC' <= as_of
  UNION
  SELECT r.org_id FROM reports r
   WHERE r.status = 'open'
     AND (r.closes_at <= as_of
       OR (NOT EXISTS (
             SELECT 1 FROM trips t
               JOIN expenses e ON e.org_id = t.org_id AND e.trip_id = t.id
              WHERE t.org_id = r.org_id AND t.report_id = r.id)
           AND NOT EXISTS (
             SELECT 1 FROM expenses e WHERE e.org_id = r.org_id AND e.report_id = r.id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_work_due(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_work_due(timestamptz) TO expensewise_app;
