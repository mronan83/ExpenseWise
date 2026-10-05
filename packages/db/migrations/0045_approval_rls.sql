-- Single-step approval (#24, ADR-0043). Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Three things the database keeps, beside the code:
--   seeing    an approver sees the reports routed to them, and what is on them: the trips, the
--             expenses and their receipts, and what hangs off those (ADR-0035 point 4).
--   deciding  whoever may decide a report changes its status and its expenses' status, and
--             records rejections, on someone else's records: those columns only, on that
--             report only, while its step is pending. Nothing else of theirs.
--   routing   a member routes only their own report, and only a pending step is decided, by
--             whoever may decide it, or by a one-person organization's owner on their own.

-- Rejections: tenant data under forced row-level security, and their expense's member's, like
-- everything else that hangs off an expense. Never changed once written; they go with their
-- expense.
GRANT SELECT, INSERT, DELETE ON expense_rejections TO expensewise_app;
--> statement-breakpoint
ALTER TABLE expense_rejections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_rejections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON expense_rejections;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_rejections
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON expense_rejections;
--> statement-breakpoint
CREATE POLICY own_records ON expense_rejections AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = expense_rejections.org_id AND e.id = expense_rejections.expense_id));
--> statement-breakpoint

-- The report an expense is on: its own, as a local expense, or its trip's. Run as the owner,
-- so a policy can ask it without the policies of trips calling back into it.
CREATE OR REPLACE FUNCTION app_expense_report(org uuid, trip uuid, report uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(report, (SELECT t.report_id FROM trips t WHERE t.org_id = org AND t.id = trip))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_report_of_expense(org uuid, expense uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_expense_report(e.org_id, e.trip_id, e.report_id)
    FROM expenses e WHERE e.org_id = org AND e.id = expense
$$;
--> statement-breakpoint
-- Whether the acting member is the approver a step of report `report` went to: from routing
-- on, they see it and what is on it.
CREATE OR REPLACE FUNCTION app_approver_of(org uuid, report uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(report IS NOT NULL AND org = app_current_org() AND EXISTS (
    SELECT 1 FROM approval_steps s
     WHERE s.org_id = org AND s.report_id = report
       AND s.approver_member_id = app_current_member()), false)
$$;
--> statement-breakpoint

-- Reads: each member's own records, as migration 0034 keeps them, and now also what is on a
-- report routed to them.
DROP POLICY IF EXISTS own_records ON reports;
--> statement-breakpoint
CREATE POLICY own_records ON reports AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member()
         OR app_approver_of(org_id, id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON trips;
--> statement-breakpoint
CREATE POLICY own_records ON trips AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member()
         OR app_approver_of(org_id, report_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON expenses;
--> statement-breakpoint
CREATE POLICY own_records ON expenses AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member()
         OR app_approver_of(org_id, app_expense_report(org_id, trip_id, report_id)));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON receipts;
--> statement-breakpoint
CREATE POLICY own_records ON receipts AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member()
         OR app_approver_of(org_id, app_report_of_expense(org_id, expense_id)));
--> statement-breakpoint

-- The report the current transaction decides, set by decideReport() for that transaction only.
CREATE OR REPLACE FUNCTION app_deciding_report() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.deciding_report', true), '')::uuid $$;
--> statement-breakpoint
-- Whether the acting member may decide someone else's report now (mayDecide() in the domain):
-- it waits on a pending step, they have an approving role, and they are the approver it went
-- to or an owner or finance admin. Their own report is never theirs to decide here; a
-- one-person organization's owner decides theirs as its member.
CREATE OR REPLACE FUNCTION app_may_decide(org uuid, report uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(org = app_current_org()
     AND app_current_member_role() IN ('approver', 'finance_admin', 'owner')
     AND EXISTS (
       SELECT 1 FROM reports r
         JOIN approval_steps s ON s.org_id = r.org_id AND s.report_id = r.id
        WHERE r.org_id = org AND r.id = report
          AND r.member_id <> app_current_member()
          AND s.decision = 'pending'
          AND (s.approver_member_id = app_current_member()
               OR app_current_member_role() IN ('owner', 'finance_admin'))), false)
$$;
--> statement-breakpoint
-- Whether the acting member self-attests report `report`: their own, with an approving role, in
-- an organization of one active member (canApprove() in the domain, FR-GOV-03).
CREATE OR REPLACE FUNCTION app_self_attests(org uuid, report uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(org = app_current_org()
     AND app_current_member_role() IN ('approver', 'finance_admin', 'owner')
     AND EXISTS (SELECT 1 FROM reports r
                  WHERE r.org_id = org AND r.id = report AND r.member_id = app_current_member())
     AND (SELECT count(*) FROM members m
           WHERE m.org_id = org AND m.deactivated_at IS NULL) = 1, false)
$$;
--> statement-breakpoint
-- The report a row of `tbl` is on, as a decision sees it.
CREATE OR REPLACE FUNCTION app_row_report(tbl text, org uuid, rec jsonb) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF tbl = 'reports' THEN
    RETURN (rec->>'id')::uuid;
  ELSIF tbl = 'expenses' THEN
    RETURN app_expense_report(org, (rec->>'trip_id')::uuid, (rec->>'report_id')::uuid);
  ELSIF tbl = 'expense_rejections' THEN
    RETURN app_report_of_expense(org, (rec->>'expense_id')::uuid);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Whether a change touches only what a decision changes: a report's state and the times that go
-- with it, and an expense's status.
CREATE OR REPLACE FUNCTION app_decision_change(tbl text, before jsonb, after jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE tbl
    WHEN 'reports' THEN
      (before - ARRAY['status', 'closed_at', 'closes_at', 'approved_at', 'updated_at'])
        = (after - ARRAY['status', 'closed_at', 'closes_at', 'approved_at', 'updated_at'])
    WHEN 'expenses' THEN
      (before - ARRAY['status', 'updated_at']) = (after - ARRAY['status', 'updated_at'])
    ELSE false
  END
$$;
--> statement-breakpoint

-- Writes: as migration 0034, and a decision on the report being decided.
CREATE OR REPLACE FUNCTION enforce_own_records() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean := true;
  deciding uuid;
BEGIN
  IF app_current_member() IS NOT NULL THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      allowed := app_changes_member(app_record_owner(TG_ARGV[0], OLD.org_id, to_jsonb(OLD)));
    END IF;
    IF allowed AND TG_OP IN ('INSERT', 'UPDATE') THEN
      allowed := app_changes_member(app_record_owner(TG_ARGV[0], NEW.org_id, to_jsonb(NEW)));
    END IF;
    deciding := app_deciding_report();
    IF NOT allowed AND TG_OP <> 'DELETE' AND deciding IS NOT NULL THEN
      IF app_may_decide(NEW.org_id, deciding) THEN
        IF TG_OP = 'UPDATE' THEN
          allowed := app_row_report(TG_TABLE_NAME, OLD.org_id, to_jsonb(OLD)) = deciding
                 AND app_row_report(TG_TABLE_NAME, NEW.org_id, to_jsonb(NEW)) = deciding
                 AND app_decision_change(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW));
        ELSE
          allowed := TG_TABLE_NAME = 'expense_rejections'
                 AND app_row_report(TG_TABLE_NAME, NEW.org_id, to_jsonb(NEW)) = deciding;
        END IF;
        allowed := coalesce(allowed, false);
      END IF;
    END IF;
    IF NOT allowed THEN
      RAISE EXCEPTION 'own_records: as %, this member may not change that % row',
        coalesce(app_current_member_role(), 'member'), TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Approval steps: a member routes only their own report, a step is decided only while
-- pending, and never deleted by a member. The system, with no member named, does as it must.
CREATE OR REPLACE FUNCTION enforce_approval_steps() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF app_current_member() IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    allowed := NEW.decision = 'pending' AND app_changes_member(
      (SELECT r.member_id FROM reports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id));
  ELSIF TG_OP = 'UPDATE' THEN
    allowed := OLD.decision = 'pending'
           AND NEW.org_id = OLD.org_id AND NEW.report_id = OLD.report_id
           AND NEW.sequence = OLD.sequence
           AND (app_may_decide(OLD.org_id, OLD.report_id)
                OR app_self_attests(OLD.org_id, OLD.report_id));
  END IF;
  IF NOT coalesce(allowed, false) THEN
    RAISE EXCEPTION 'own_records: as %, this member may not change that approval_steps row',
      coalesce(app_current_member_role(), 'member')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON approval_steps;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_steps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expense_rejections;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expense_rejections
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint

-- An expense's rejections go just before it does, while it is still there to say whose they
-- are, as its lines and conversion do (migrations 0042, 0043). The cascade stays as a backstop.
CREATE OR REPLACE FUNCTION delete_expense_rejections() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  DELETE FROM expense_rejections x WHERE x.org_id = OLD.org_id AND x.expense_id = OLD.id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_rejections_first ON expenses;
--> statement-breakpoint
CREATE TRIGGER expense_rejections_first BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION delete_expense_rejections();
--> statement-breakpoint

-- An approved expense is locked (FR-EXP-03): nothing changes it but settling it, whoever asks,
-- the system included. A correction is a reversal and a new version (#87).
CREATE OR REPLACE FUNCTION lock_approved_expenses() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status IN ('approved', 'settled')
     AND ((to_jsonb(NEW) - ARRAY['status', 'updated_at'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at'])
          OR NOT (NEW.status = OLD.status OR (OLD.status = 'approved' AND NEW.status = 'settled'))) THEN
    RAISE EXCEPTION 'locked: expense % is %, and is corrected by a reversal', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS approved_locked ON expenses;
--> statement-breakpoint
CREATE TRIGGER approved_locked BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION lock_approved_expenses();
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_expense_report(uuid, uuid, uuid), app_report_of_expense(uuid, uuid),
  app_approver_of(uuid, uuid), app_deciding_report(), app_may_decide(uuid, uuid),
  app_self_attests(uuid, uuid), app_row_report(text, uuid, jsonb),
  app_decision_change(text, jsonb, jsonb), enforce_approval_steps(), delete_expense_rejections(),
  lock_approved_expenses()
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_expense_report(uuid, uuid, uuid), app_report_of_expense(uuid, uuid),
  app_approver_of(uuid, uuid), app_deciding_report(), app_may_decide(uuid, uuid),
  app_self_attests(uuid, uuid), app_row_report(text, uuid, jsonb),
  app_decision_change(text, jsonb, jsonb)
  TO expensewise_app;
--> statement-breakpoint

-- The schedule leaves alone an open report that holds nothing but has been through approval:
-- it is never dropped, since its steps and rejections are its history. Otherwise as migration
-- 0024; same signature, so the release before this one still calls it.
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
             SELECT 1 FROM expenses e WHERE e.org_id = r.org_id AND e.report_id = r.id)
           AND NOT EXISTS (
             SELECT 1 FROM approval_steps s WHERE s.org_id = r.org_id AND s.report_id = r.id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_work_due(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_work_due(timestamptz) TO expensewise_app;
