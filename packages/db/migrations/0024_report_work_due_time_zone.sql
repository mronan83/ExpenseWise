-- The organization's time zone in the report schedule (FR-PLT-11, ADR-0037). Hand-written
-- (drizzle-kit --custom).

-- Something joins a report 24 hours after its day ends. With no time zone the day is counted
-- at UTC−12, where it ends last, which is noon UTC two days on, as before; with one, where the
-- organization is (lastDayToJoin() in the domain). Due when its date is on or before the local
-- date 24 hours ago, less a day. Every zone's date is on or after UTC−12's, so this names every
-- organization the earlier version did and some a few hours sooner. It reads the time zone
-- whether or not the organization's settings are switched on: the run inside the organization
-- decides that, and finds nothing due when they are off. Same signature, so the release before
-- this one still calls it. Postgres checks a time zone when the app sets it.
CREATE OR REPLACE FUNCTION report_work_due(as_of timestamptz) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.org_id FROM trips t
    JOIN organizations o ON o.id = t.org_id
   WHERE t.report_id IS NULL
     AND t.end_date <=
         ((as_of - interval '24 hours') AT TIME ZONE coalesce(o.time_zone, 'Etc/GMT+12'))::date - 1
     AND EXISTS (
       SELECT 1 FROM expenses e
        WHERE e.org_id = t.org_id AND e.trip_id = t.id
          AND e.status IN ('processing', 'needs_review', 'ready'))
  UNION
  SELECT e.org_id FROM expenses e
    JOIN organizations o ON o.id = e.org_id
   WHERE e.trip_id IS NULL AND e.report_id IS NULL AND e.transaction_date IS NOT NULL
     AND e.status IN ('needs_review', 'ready')
     AND e.transaction_date <=
         ((as_of - interval '24 hours') AT TIME ZONE coalesce(o.time_zone, 'Etc/GMT+12'))::date - 1
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
