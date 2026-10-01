-- Tenant isolation, append-only audit log and outbox relay access.
-- Hand-written (drizzle-kit --custom). See docs/05-architecture.md (AP4, AP6) and ADR-0008.
--
-- Roles
--   expensewise_app    the API and workers. Subject to row-level security on every tenant table.
--   expensewise_relay  the outbox relay. Can only call claim/mark functions, never read tables.
-- Both are NOLOGIN here; each environment grants LOGIN and a password out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'expensewise_app') THEN
    CREATE ROLE expensewise_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'expensewise_relay') THEN
    CREATE ROLE expensewise_relay NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- The organization for the current transaction, set by withOrg() via set_config('app.org_id', ..., true).
-- No setting means no organization, and every policy below then matches nothing.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO expensewise_app, expensewise_relay;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org() TO expensewise_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, members, trips, categories, reports, expenses,
  receipts, extraction_runs, mileage_logs, approval_steps
  TO expensewise_app;
--> statement-breakpoint
-- The audit log and outbox are insert-only for the application.
GRANT SELECT, INSERT ON audit_events, outbox_events TO expensewise_app;
--> statement-breakpoint

-- Row-level security. FORCE applies the policies to the table owner too (when the owner
-- is not a superuser, as on managed Postgres). Every new tenant table must be added here;
-- test/tenancy.int.test.ts fails if one is missing.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trips
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categories
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reports
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON extraction_runs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE mileage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mileage_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mileage_logs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_steps
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
-- The outbox is deliberately NOT forced: the relay functions below run as the table owner
-- and must see every organization's unpublished events. The application role is still
-- confined to its own organization by this policy.
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Append-only audit log. Grants already withhold UPDATE and DELETE from the application;
-- this trigger also stops the table owner and anyone else.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- Outbox relay. Claims a batch across all organizations; a claim expires after 5 minutes
-- so a crashed relay never strands an event.
CREATE OR REPLACE FUNCTION claim_outbox_batch(batch_size integer DEFAULT 100)
  RETURNS SETOF outbox_events
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE outbox_events AS o
       SET claimed_at = now(), attempts = o.attempts + 1
     WHERE o.id IN (
       SELECT id FROM outbox_events
        WHERE published_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY created_at
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED)
    RETURNING o.*
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_outbox_published(event_ids uuid[])
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH published AS (
      UPDATE outbox_events SET published_at = now()
       WHERE id = ANY(event_ids) AND published_at IS NULL
      RETURNING 1)
    SELECT count(*)::integer FROM published
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_outbox_batch(integer), mark_outbox_published(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_outbox_batch(integer), mark_outbox_published(uuid[]) TO expensewise_relay;
