-- Push notifications (FR-PLT-12, ADR-0053): where a member's notifications go, the kinds they
-- switched, the notifications made for them, and how far the audit trail has been read.
-- Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Tenant data under the same forced row-level security as every other tenant table, and a
-- member's own with the restrictive own_records policy and trigger, as saved places are
-- (ADR-0035). A subscription, a preference and a notification are stricter still, with
-- own_only: unlike most of a member's records, not even an owner, a finance admin or an
-- auditor sees another's, since a subscription's address and keys are enough to push to that
-- person's phone. The system (no member) sees and changes all of them, as the sweep must.

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO expensewise_app;
--> statement-breakpoint
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON push_subscriptions;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON push_subscriptions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_only ON push_subscriptions;
--> statement-breakpoint
CREATE POLICY own_only ON push_subscriptions AS RESTRICTIVE
  USING (app_current_member() IS NULL OR member_id = app_current_member())
  WITH CHECK (app_current_member() IS NULL OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON push_subscriptions;
--> statement-breakpoint
CREATE POLICY own_records ON push_subscriptions AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON push_subscriptions;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO expensewise_app;
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON notification_preferences;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_preferences
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_only ON notification_preferences;
--> statement-breakpoint
CREATE POLICY own_only ON notification_preferences AS RESTRICTIVE
  USING (app_current_member() IS NULL OR member_id = app_current_member())
  WITH CHECK (app_current_member() IS NULL OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON notification_preferences;
--> statement-breakpoint
CREATE POLICY own_records ON notification_preferences AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON notification_preferences;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO expensewise_app;
--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON notifications;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS own_only ON notifications;
--> statement-breakpoint
CREATE POLICY own_only ON notifications AS RESTRICTIVE
  USING (app_current_member() IS NULL OR member_id = app_current_member())
  WITH CHECK (app_current_member() IS NULL OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON notifications;
--> statement-breakpoint
CREATE POLICY own_records ON notifications AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON notifications;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint

-- A member's first subscription makes the cursor, at the end of the trail; only the sweep
-- (no member) moves it on.
GRANT SELECT, INSERT, UPDATE ON push_cursors TO expensewise_app;
--> statement-breakpoint
ALTER TABLE push_cursors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_cursors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON push_cursors;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON push_cursors
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS moved_by_the_sweep ON push_cursors;
--> statement-breakpoint
CREATE POLICY moved_by_the_sweep ON push_cursors AS RESTRICTIVE FOR UPDATE
  USING (app_current_member() IS NULL);
--> statement-breakpoint

-- The organizations with notifications to make or send at `as_of`, as ids only: one with a
-- member who allowed notifications and either a change on its trail past the cursor that may
-- be notified, or a notification still to send; with `reminders`, also one with a closed
-- report not reminded of in the last 23 hours. The sweep asks this every five minutes, then
-- does the work inside each organization as the app. It runs as its owner because the sweep
-- is in no organization yet, and answers with ids only, as report_work_due() does.
CREATE OR REPLACE FUNCTION push_work_due(as_of timestamptz, reminders boolean) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.org_id FROM push_cursors c
   WHERE EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.org_id = c.org_id)
     AND (EXISTS (
            SELECT 1 FROM audit_events a
             WHERE a.org_id = c.org_id AND a.sequence > c.sequence
               AND a.action IN ('receipt.read', 'receipt.possible_duplicate',
                                'inbound_email.received', 'report.trip_added', 'report.closed',
                                'report.submitted', 'report.approved', 'report.returned',
                                'expense.route_not_measured', 'card_statement.read'))
       OR EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.org_id = c.org_id AND n.sent_at IS NULL AND n.tries < 3
               AND n.created_at > as_of - interval '1 day')
       OR (reminders AND EXISTS (
            SELECT 1 FROM reports r
              JOIN push_subscriptions s ON s.org_id = r.org_id AND s.member_id = r.member_id
             -- As text: on a new database the value is added in the same run (55P04).
             WHERE r.org_id = c.org_id AND r.status::text = 'closed'
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                  WHERE n.org_id = r.org_id AND n.member_id = r.member_id
                    AND n.dedupe_key LIKE 'submit:' || r.id || ':%'
                    AND n.created_at > as_of - interval '23 hours'))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION push_work_due(timestamptz, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION push_work_due(timestamptz, boolean) TO expensewise_app;
